import express from 'express';
import path from 'path';
import cors from 'cors';
import crypto from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { GoogleAuth } from 'google-auth-library';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { TwitterApi } from 'twitter-api-v2';
import webpush from 'web-push';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import fs from 'fs';

dotenv.config();

// Lazy initialization for Firebase Admin
function ensureFirebaseAdmin() {
  if (!getApps().length) {
    if (process.env.FIREBASE_CONFIG || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp();
    } else {
      initializeApp({ projectId: 'twittertry2-8a870' });
    }
  }
}

function getAdminDb() {
  ensureFirebaseAdmin();
  return getFirestore();
}

function getAdminAuth() {
  ensureFirebaseAdmin();
  return getAuth();
}

function getAppBaseUrl(): string {
  return (process.env.APP_URL || 'https://stone-content-manager.web.app').replace(/\/$/, '');
}

// Service Account Google Drive Auth (ADC / Cloud Functions runtime service account)
const driveAuth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});

async function getServiceAccountDriveToken(): Promise<string> {
  const client = await driveAuth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
  if (!token) {
    throw new Error('Unable to acquire a Google Drive access token from the service account.');
  }
  return token;
}

async function getServiceAccountEmail(): Promise<string | null> {
  try {
    const creds = await driveAuth.getCredentials();
    if (creds?.client_email) {
      return creds.client_email;
    }
  } catch {
    // Fallback to GCE metadata server below when running on Cloud Functions / Cloud Run
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const metaRes = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (metaRes.ok) {
      const email = (await metaRes.text()).trim();
      if (email) return email;
    }
  } catch {
    // Not running on GCP metadata environment
  }

  return null;
}

async function resolveDriveToken(providedToken?: string): Promise<string> {
  if (providedToken && providedToken !== 'SERVICE_ACCOUNT') {
    return providedToken;
  }
  return getServiceAccountDriveToken();
}

async function fetchDriveWithFallback(
  url: string,
  init: RequestInit,
  providedToken?: string
): Promise<{ response: Response; usedToken: string }> {
  const primaryToken = await resolveDriveToken(providedToken);
  const firstHeaders = new Headers(init.headers || {});
  firstHeaders.set('Authorization', `Bearer ${primaryToken}`);
  const firstRes = await fetch(url, { ...init, headers: firstHeaders });

  if (firstRes.status === 401 && providedToken && providedToken !== 'SERVICE_ACCOUNT') {
    try {
      const saToken = await getServiceAccountDriveToken();
      const retryHeaders = new Headers(init.headers || {});
      retryHeaders.set('Authorization', `Bearer ${saToken}`);
      const retryRes = await fetch(url, { ...init, headers: retryHeaders });
      return { response: retryRes, usedToken: saToken };
    } catch {
      return { response: firstRes, usedToken: primaryToken };
    }
  }

  return { response: firstRes, usedToken: primaryToken };
}

// Lazy initialization helper for Gemini
let aiInstance: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is missing. Please add it to your environment settings.');
    }
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiInstance;
}

// VAPID Key Management (env vars first, otherwise auto-generated & persisted in _system/vapid)
let cachedVapidKeys: { publicKey: string; privateKey: string } | null = null;

async function getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (cachedVapidKeys) return cachedVapidKeys;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    cachedVapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    return cachedVapidKeys;
  }

  const db = getAdminDb();
  const vapidRef = db.doc('_system/vapid');
  const snap = await vapidRef.get();
  if (snap.exists) {
    const data = snap.data();
    if (data?.publicKey && data?.privateKey) {
      cachedVapidKeys = {
        publicKey: data.publicKey,
        privateKey: data.privateKey,
      };
      return cachedVapidKeys;
    }
  }

  const generated = webpush.generateVAPIDKeys();
  await vapidRef.set({
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: Date.now(),
  });
  cachedVapidKeys = generated;
  return cachedVapidKeys;
}

function hashEndpoint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  postId?: string;
}

async function sendWebPushToUser(
  uid: string,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number; cleanedUp: number }> {
  const { publicKey, privateKey } = await getVapidKeys();
  webpush.setVapidDetails(
    `mailto:notifications@${new URL(getAppBaseUrl()).hostname}`,
    publicKey,
    privateKey
  );

  const db = getAdminDb();
  const subsSnap = await db.collection(`users/${uid}/pushSubscriptions`).get();
  if (subsSnap.empty) {
    return { sent: 0, failed: 0, cleanedUp: 0 };
  }

  let sent = 0;
  let failed = 0;
  let cleanedUp = 0;
  const serialized = JSON.stringify({
    ...payload,
    url: payload.url || getAppBaseUrl(),
  });

  await Promise.all(
    subsSnap.docs.map(async (subDoc) => {
      const data = subDoc.data();
      if (!data?.endpoint || !data?.keys?.p256dh || !data?.keys?.auth) {
        return;
      }
      try {
        await webpush.sendNotification(
          {
            endpoint: data.endpoint,
            keys: {
              p256dh: data.keys.p256dh,
              auth: data.keys.auth,
            },
          },
          serialized
        );
        sent++;
      } catch (err: any) {
        failed++;
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await subDoc.ref.delete().catch(() => {});
          cleanedUp++;
        } else {
          console.error(`Web Push send error for user ${uid}:`, err?.message || err);
        }
      }
    })
  );

  return { sent, failed, cleanedUp };
}

async function sendWebhookNotification(
  webhookUrl: string,
  title: string,
  message: string
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const isNtfyTopicUrl = /https?:\/\/([^/]*\.)?ntfy\.sh\/[^/?#]+/i.test(webhookUrl);
    if (isNtfyTopicUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Title: title,
        },
        body: message,
      });
      return;
    }

    const isDiscord = /discord(app)?\.com\/api\/webhooks\//i.test(webhookUrl);
    if (isDiscord) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${message}` }),
      });
      return;
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${title}\n${message}`,
        title,
        message,
      }),
    });
  } catch (webhookErr) {
    console.error('Webhook notification error:', webhookErr);
  }
}

const app = express();
app.set('trust proxy', 1);
const PORT = 3000;

// DDoS & Rate Limiting Protection Setup
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});

// Stricter rate limiter for compute-heavy AI/Publish APIs to mitigate API Abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // Limit each IP to 30 sensitive endpoint requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Sensitive API rate limit reached. Please wait 15 minutes before retrying.' },
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Apply general rate limiting to all requests
app.use(generalLimiter);

// Request Logging Middleware for auditing incoming requests
app.use((req, res, next) => {
  const line = `[${new Date().toISOString()}] ${req.method} ${req.path} - Headers: ${JSON.stringify(req.headers)}\n`;
  try {
    fs.appendFileSync(path.join(process.cwd(), 'requests.log'), line);
  } catch {
    // Read-only filesystem in some serverless environments (e.g., Cloud Functions)
  }
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

// Middleware to verify Firebase ID Token on authenticated routes
async function requireFirebaseUser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  try {
    const decoded = await getAdminAuth().verifyIdToken(match[1]);
    (req as any).uid = decoded.uid;
    next();
  } catch (err: any) {
    console.error('Firebase token verification failed:', err?.message || err);
    return res.status(401).json({ error: 'Invalid or expired Firebase authentication token' });
  }
}

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Expose Service Account Email so users can share their Google Drive folder for 24/7 polling
app.get(['/api/drive/service-account', '/api/drive/service-account/'], async (req, res) => {
  const email = await getServiceAccountEmail();
  res.json({
    available: Boolean(email),
    email,
  });
});

// Web Push: Public VAPID key
app.get(['/api/push/vapid-public-key', '/api/push/vapid-public-key/'], async (req, res) => {
  try {
    const { publicKey } = await getVapidKeys();
    res.json({ publicKey });
  } catch (err: any) {
    console.error('Failed retrieving VAPID public key:', err);
    res.status(500).json({ error: err?.message || 'Failed to load Web Push key' });
  }
});

// Web Push: Register/update a browser subscription
app.post(['/api/push/subscribe', '/api/push/subscribe/'], requireFirebaseUser, async (req, res) => {
  const uid: string = (req as any).uid;
  const { subscription, deviceLabel } = req.body || {};

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid Web Push subscription payload' });
  }

  try {
    const db = getAdminDb();
    const subId = hashEndpoint(subscription.endpoint);
    const now = Date.now();
    const ref = db.doc(`users/${uid}/pushSubscriptions/${subId}`);
    const existing = await ref.get();

    await ref.set({
      id: subId,
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.slice(0, 120) : 'Chrome Browser',
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
      updatedAt: now,
    });

    res.json({ success: true, id: subId });
  } catch (err: any) {
    console.error('Failed saving push subscription:', err);
    res.status(500).json({ error: err?.message || 'Failed saving push subscription' });
  }
});

// Web Push: Remove a browser subscription
app.post(['/api/push/unsubscribe', '/api/push/unsubscribe/'], requireFirebaseUser, async (req, res) => {
  const uid: string = (req as any).uid;
  const { endpoint } = req.body || {};

  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  try {
    const db = getAdminDb();
    const subId = hashEndpoint(endpoint);
    await db.doc(`users/${uid}/pushSubscriptions/${subId}`).delete();
    res.json({ success: true });
  } catch (err: any) {
    console.error('Failed removing push subscription:', err);
    res.status(500).json({ error: err?.message || 'Failed removing push subscription' });
  }
});

// Web Push: Send a test notification to all subscribed devices for the signed-in user
app.post(['/api/push/test', '/api/push/test/'], apiLimiter, requireFirebaseUser, async (req, res) => {
  const uid: string = (req as any).uid;
  try {
    const result = await sendWebPushToUser(uid, {
      title: 'StoneContentManager',
      body: 'Chrome notifications are working! You will be alerted here when your timer fires.',
      url: getAppBaseUrl(),
      tag: 'scm-test-notification',
    });

    if (result.sent === 0 && result.failed === 0) {
      return res.status(400).json({
        error: 'No subscribed Chrome devices found yet. Enable Chrome Notifications first.',
      });
    }

    res.json({ success: result.sent > 0, ...result });
  } catch (err: any) {
    console.error('Test push error:', err);
    res.status(500).json({ error: err?.message || 'Failed sending test notification' });
  }
});

// OAuth Drive Access Token Refresh Endpoint
app.post(['/api/auth/refresh-drive-token', '/api/auth/refresh-drive-token/'], async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Missing refreshToken' });
  }

  try {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const refreshRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!refreshRes.ok) {
      const errText = await refreshRes.text();
      throw new Error(`Google refresh request rejected: ${errText}`);
    }

    const payload: any = await refreshRes.json();
    res.json({
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
    });
  } catch (err: any) {
    console.error('Failed refreshing Google Drive token:', err);
    res.status(500).json({ error: err.message || 'Token refresh error' });
  }
});

function stripHashtags(caption: string): string {
  return caption
    .replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Helper: Parse Gemini JSON Array cleanly
function cleanAndParseJSON(text: string): string[] {
  try {
    let clean = text.trim();
    if (clean.startsWith('```json')) {
      clean = clean.substring(7);
    } else if (clean.startsWith('```')) {
      clean = clean.substring(3);
    }
    if (clean.endsWith('```')) {
      clean = clean.substring(0, clean.length - 3);
    }
    clean = clean.trim();
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) {
      return parsed.map(item => stripHashtags(String(item)));
    }
    throw new Error('Response was not a JSON array');
  } catch {
    console.error('Failed to parse Gemini response as JSON. Text was:', text);
    return [
      '✨ Captivating photo choice! Check this out on our channels.',
      '🚀 Elevating our content with beautiful visual compositions.',
      '🌟 A brand new visual story just posted. What do you think?',
    ];
  }
}

async function fetchDriveThumbnailDataUrl(
  fileId: string,
  driveToken: string,
  preferredSize = 1024
): Promise<string | null> {
  try {
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${driveToken}` },
    });
    if (!metaRes.ok) return null;

    const metaJson: any = await metaRes.json();
    if (!metaJson.thumbnailLink) return null;

    const sizedUrl = metaJson.thumbnailLink.replace(/=s\d+$/, `=s${preferredSize}`);
    let thumbRes = await fetch(sizedUrl);
    if (!thumbRes.ok && sizedUrl !== metaJson.thumbnailLink) {
      thumbRes = await fetch(metaJson.thumbnailLink);
    }
    if (!thumbRes.ok) return null;

    const thumbBuf = await thumbRes.arrayBuffer();
    const contentType = thumbRes.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${Buffer.from(thumbBuf).toString('base64')}`;
  } catch (thumbErr) {
    console.error('Google Drive thumbnail retrieval warning:', thumbErr);
    return null;
  }
}

async function analyzeDriveMedia(
  fileId: string,
  mimeType: string | undefined,
  providedToken?: string
): Promise<{ captions: string[]; imageUrl: string; usedToken: string; rawBase64Length: number }> {
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const { response: downloadRes, usedToken } = await fetchDriveWithFallback(
    driveUrl,
    {},
    providedToken
  );

  if (!downloadRes.ok) {
    throw new Error(`Failed to download from Drive: ${downloadRes.status} ${downloadRes.statusText}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64Data = buffer.toString('base64');
  const safeMimeType = mimeType || 'image/jpeg';

  const prompt = `Analyze this image or video content and generate exactly 3 distinct, compelling, and ready-to-post social media captions/texts suitable for X/Twitter & Bluesky sharing.
    Do NOT include any hashtags (#). Include sparse emojis if appropriate.
    Return ONLY a valid JSON string of array format containing exactly 3 string values, like:
    [
      "Caption idea 1...",
      "Caption idea 2...",
      "Caption idea 3..."
    ]`;

  const geminiRes = await getGeminiClient().models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [
      {
        inlineData: {
          mimeType: safeMimeType,
          data: base64Data,
        },
      },
      prompt,
    ],
  });

  const outputText = geminiRes.text || '';
  const captions = cleanAndParseJSON(outputText);

  let returnedImageUrl = `data:${safeMimeType};base64,${base64Data}`;

  if (safeMimeType.startsWith('video/')) {
    const thumbDataUrl = await fetchDriveThumbnailDataUrl(fileId, usedToken, 800);
    if (thumbDataUrl) {
      returnedImageUrl = thumbDataUrl;
    } else {
      returnedImageUrl = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="100%" height="100%" fill="%231c1917"/><circle cx="300" cy="200" r="40" fill="%23eab308"/><polygon points="288,180 320,200 288,220" fill="%230c0a09"/><text x="300" y="280" fill="%23f5f5f4" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle">Video Preview Ready</text><text x="300" y="310" fill="%2378716c" font-family="sans-serif" font-size="12" text-anchor="middle">Short clip scanned by Gemini</text></svg>`;
    }
  }

  return {
    captions,
    imageUrl: returnedImageUrl,
    usedToken,
    rawBase64Length: base64Data.length,
  };
}

function getNextScheduledTimeMs(minHours?: number, maxHours?: number): number {
  const minH = Number.isFinite(minHours) && (minHours as number) > 0 ? (minHours as number) : 2;
  const maxH = Number.isFinite(maxHours) && (maxHours as number) >= minH ? (maxHours as number) : Math.max(minH, 6);
  const minMs = minH * 60 * 60 * 1000;
  const maxMs = maxH * 60 * 60 * 1000;
  const randomOffset = Math.random() * (maxMs - minMs) + minMs;
  return Date.now() + Math.round(randomOffset);
}

async function appendUserLog(
  uid: string,
  type: 'info' | 'success' | 'error',
  message: string
): Promise<void> {
  const db = getAdminDb();
  const logId = `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  await db.doc(`users/${uid}/logs/${logId}`).set({
    id: logId,
    type,
    message,
    timestamp: Date.now(),
  });
}

async function pollDriveAndDraftForUser(
  uid: string,
  config: Record<string, any>,
  providedToken?: string
): Promise<{
  createdPostId?: string;
  fileName?: string;
  skipped?: boolean;
  reason?: string;
  pushResult?: { sent: number; failed: number; cleanedUp: number };
}> {
  const db = getAdminDb();
  const userRef = db.doc(`users/${uid}`);

  // Skip polling if there is already a post waiting in the review queue
  const pendingSnap = await db
    .collection(`users/${uid}/posts`)
    .where('status', '==', 'pending_review')
    .limit(1)
    .get();

  if (!pendingSnap.empty) {
    const nextTime = getNextScheduledTimeMs(config.minIntervalHours, config.maxIntervalHours);
    await userRef.set({ nextPostTime: nextTime, updatedAt: Date.now() }, { merge: true });
    await appendUserLog(
      uid,
      'info',
      `Auto-poll skipped — a post is already pending review. Rescheduled for: ${new Date(nextTime).toLocaleTimeString()}`
    );
    return { skipped: true, reason: 'pending_review' };
  }

  // Advance schedule immediately so concurrent ticks cannot re-trigger this cycle
  const nextTime = getNextScheduledTimeMs(config.minIntervalHours, config.maxIntervalHours);
  await userRef.set({ nextPostTime: nextTime, updatedAt: Date.now() }, { merge: true });
  await appendUserLog(uid, 'info', `Scanning Google Drive Location for assets: [${config.driveFolderId}]`);

  const listUrl = `https://www.googleapis.com/drive/v3/files?q='${config.driveFolderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=100`;
  const { response: listRes, usedToken } = await fetchDriveWithFallback(listUrl, {}, providedToken);

  if (!listRes.ok) {
    const errBody = await listRes.text().catch(() => listRes.statusText);
    throw new Error(`Google Drive returned ${listRes.status} (${listRes.statusText}): ${errBody}`);
  }

  const rawResult: any = await listRes.json();
  const items = rawResult.files || [];
  const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
  const mediaItems = items.filter((f: any) => {
    const isSupportedType = f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/');
    const isSizeAcceptable = !f.size || parseInt(f.size, 10) <= MAX_FILE_SIZE_BYTES;
    return isSupportedType && isSizeAcceptable;
  });

  if (mediaItems.length === 0) {
    await appendUserLog(uid, 'info', 'No compatible image/video assets discovered in target Drive folder.');
    return { skipped: true, reason: 'no_media' };
  }

  const postsSnap = await db.collection(`users/${uid}/posts`).get();
  const processedIds = new Set(postsSnap.docs.map(d => d.data()?.driveFileId).filter(Boolean));
  const unprocessedMedia = mediaItems.filter((m: any) => !processedIds.has(m.id));
  const pool = unprocessedMedia.length > 0 ? unprocessedMedia : mediaItems;
  if (unprocessedMedia.length === 0) {
    await appendUserLog(uid, 'info', 'All files in folder have been previously posted or skipped. Cycling random selection...');
  }
  const selectedFile = pool[Math.floor(Math.random() * pool.length)];

  await appendUserLog(
    uid,
    'info',
    `Selected asset: '${selectedFile.name}' (${selectedFile.id}). Triggering Gemini visual captioning...`
  );

  const analyzed = await analyzeDriveMedia(selectedFile.id, selectedFile.mimeType, usedToken);

  // Ensure imageUrl fits comfortably below Firestore's 1 MB document limit
  let firestoreImageUrl = analyzed.imageUrl;
  if (firestoreImageUrl.startsWith('data:image/') && firestoreImageUrl.length > 600_000) {
    const thumb = await fetchDriveThumbnailDataUrl(selectedFile.id, analyzed.usedToken, 1024);
    if (thumb && thumb.length <= 750_000) {
      firestoreImageUrl = thumb;
    } else {
      const smallerThumb = await fetchDriveThumbnailDataUrl(selectedFile.id, analyzed.usedToken, 640);
      if (smallerThumb) {
        firestoreImageUrl = smallerThumb;
      }
    }
  }

  const newPostId = `post_${Date.now()}`;
  const newPostNode = {
    id: newPostId,
    driveFileId: selectedFile.id,
    fileName: selectedFile.name,
    mimeType: selectedFile.mimeType || 'image/jpeg',
    imageUrl: firestoreImageUrl,
    captions: analyzed.captions,
    selectedCaption: analyzed.captions[0] || '',
    status: 'pending_review',
    createdAt: Date.now(),
  };

  await db.doc(`users/${uid}/posts/${newPostId}`).set(newPostNode);

  let pushResult = { sent: 0, failed: 0, cleanedUp: 0 };
  if (config.pushNotificationsEnabled !== false) {
    try {
      pushResult = await sendWebPushToUser(uid, {
        title: 'New Post Ready for Review',
        body: `"${selectedFile.name}" — 3 AI captions ready to review & publish.`,
        url: getAppBaseUrl(),
        tag: 'stone-content-review',
        postId: newPostId,
      });
    } catch (pushErr) {
      console.error(`Failed sending Chrome Web Push for user ${uid}:`, pushErr);
    }
  }

  if (config.webhookEnabled && config.webhookUrl) {
    await sendWebhookNotification(
      config.webhookUrl,
      'Social Poster Review',
      `🔔 New Media Proposed: "${selectedFile.name}"! Three caption alternatives ready for edits.`
    );
  }

  const notifyNote =
    pushResult.sent > 0
      ? `Chrome push sent to ${pushResult.sent} device(s).`
      : 'Draft saved (no active Chrome push subscriptions).';

  await appendUserLog(
    uid,
    'success',
    `Generated 3 custom captions for '${selectedFile.name}'! ${notifyNote}`
  );

  return {
    createdPostId: newPostId,
    fileName: selectedFile.name,
    pushResult,
  };
}

// 1. POST Endpoint to fetch and caption photo/video from Google Drive
app.post(['/api/posts/analyze-gdrive', '/api/posts/analyze-gdrive/'], apiLimiter, async (req, res) => {
  const { fileId, mimeType, gdriveToken } = req.body;

  if (!fileId) {
    return res.status(400).json({ error: 'Missing fileId' });
  }

  try {
    const analyzed = await analyzeDriveMedia(fileId, mimeType, gdriveToken);
    res.json({
      success: true,
      captions: analyzed.captions,
      imageUrl: analyzed.imageUrl,
    });
  } catch (error: any) {
    console.error('Error analyzing GDrive file:', error);
    res.status(500).json({ error: error?.message || 'Failed to download or analyze with Gemini' });
  }
});

// 1b. POST Endpoint to run full poll -> Gemini -> Firestore -> Chrome Push on the server
app.post(['/api/posts/poll-now', '/api/posts/poll-now/'], apiLimiter, requireFirebaseUser, async (req, res) => {
  const uid: string = (req as any).uid;
  const { gdriveToken } = req.body || {};

  try {
    const db = getAdminDb();
    const userDoc = await db.doc(`users/${uid}`).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User configuration not found' });
    }
    const config = userDoc.data() || {};
    const result = await pollDriveAndDraftForUser(uid, config, gdriveToken);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Server poll-now failed:', error);
    await appendUserLog(uid, 'error', `Polling event error: ${error?.message || error}`).catch(() => {});
    res.status(500).json({ error: error?.message || 'Polling pipeline failed' });
  }
});

// 2. POST Endpoint to analyze manual upload
app.post(['/api/posts/analyze-upload', '/api/posts/analyze-upload/'], apiLimiter, async (req, res) => {
  const { mimeType, base64Data } = req.body;

  if (!base64Data) {
    return res.status(400).json({ error: 'Missing base64Data for analysis' });
  }

  try {
    const prompt = `Analyze this uploaded image and generate exactly 3 highly engaging social media captions suited for Twitter/X and Bluesky.
    Represent the content beautifully. Keep captions concise and optimized. Do NOT include any hashtags (#).
    Return ONLY a valid JSON string array of exactly 3 strings conforming to:
    ["Caption 1", "Caption 2", "Caption 3"]`;

    const cleanBase64 = base64Data.split(',')[1] || base64Data;
    const safeMimeType = mimeType || 'image/jpeg';

    const geminiRes = await getGeminiClient().models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: safeMimeType,
            data: cleanBase64,
          },
        },
        prompt,
      ],
    });

    const outputText = geminiRes.text || '';
    const captions = cleanAndParseJSON(outputText);

    res.json({
      success: true,
      captions,
      imageUrl: base64Data.startsWith('data:') ? base64Data : `data:${safeMimeType};base64,${cleanBase64}`,
    });
  } catch (error: any) {
    console.error('Error analyzing uploaded file:', error);
    res.status(500).json({ error: error?.message || 'Failed to analyze uploaded photo' });
  }
});

// 3. POST Endpoint to publish to Bluesky and X
app.post(['/api/posts/publish', '/api/posts/publish/'], apiLimiter, async (req, res) => {
  const {
    caption,
    imageUrl,
    bluesky,
    twitter,
    webhookUrl,
  } = req.body;

  if (!caption) {
    return res.status(400).json({ error: 'Caption is required' });
  }

  const results: Record<string, any> = { bsky: null, x: null };

  try {
    const fileBase64 = imageUrl?.split(',')[1] || imageUrl;
    const mimeTypeStr = imageUrl?.split(';')[0]?.slice(5) || 'image/jpeg';
    const mediaBuffer = fileBase64 ? Buffer.from(fileBase64, 'base64') : null;

    // A. Post to Bluesky if enabled
    if (bluesky?.enabled && bluesky?.username && bluesky?.password) {
      try {
        const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: bluesky.username,
            password: bluesky.password,
          }),
        });

        if (!sessionRes.ok) {
          throw new Error(`BSky Authentication failed: ${sessionRes.statusText}`);
        }

        const session = await sessionRes.json();
        const { accessJwt, did } = session;

        let embedObj: any = undefined;

        if (mediaBuffer) {
          const blobUploadUrl = 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob';
          const uploadRes = await fetch(blobUploadUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessJwt}`,
              'Content-Type': mimeTypeStr,
            },
            body: mediaBuffer,
          });

          if (!uploadRes.ok) {
            throw new Error(`BSky image upload failed: ${uploadRes.statusText}`);
          }

          const uploadData = await uploadRes.json();
          embedObj = {
            $type: 'app.bsky.embed.images',
            images: [
              {
                image: uploadData.blob,
                alt: 'AI generated visual post content',
              },
            ],
          };
        }

        const createRecordRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repo: did,
            collection: 'app.bsky.feed.post',
            record: {
              $type: 'app.bsky.feed.post',
              text: caption,
              createdAt: new Date().toISOString(),
              embed: embedObj,
            },
          }),
        });

        if (!createRecordRes.ok) {
          throw new Error(`BSky listing post record failed: ${createRecordRes.statusText}`);
        }

        results.bsky = { success: true, response: await createRecordRes.json() };
      } catch (bskyErr: any) {
        console.error('Bluesky error:', bskyErr);
        results.bsky = { success: false, error: bskyErr?.message || bskyErr };
      }
    }

    // B. Post to X / Twitter if enabled
    if (twitter?.enabled && twitter?.apiKey && twitter?.apiSecret && twitter?.accessToken && twitter?.accessSecret) {
      try {
        const client = new TwitterApi({
          appKey: twitter.apiKey,
          appSecret: twitter.apiSecret,
          accessToken: twitter.accessToken,
          accessSecret: twitter.accessSecret,
        });

        let mediaId: string | undefined = undefined;

        if (mediaBuffer) {
          mediaId = await client.v1.uploadMedia(mediaBuffer, { mimeType: mimeTypeStr });
        }

        const tweetPayload: any = { text: caption };
        if (mediaId) {
          tweetPayload.media = { media_ids: [mediaId] };
        }

        const tweetRes = await client.v2.tweet(tweetPayload);
        results.x = { success: true, tweetId: tweetRes.data.id };
      } catch (xErr: any) {
        console.error('Twitter/X error:', xErr);
        results.x = { success: false, error: xErr?.message || xErr };
      }
    }

    // C. Trigger smartphone notification webhook if configured
    if (webhookUrl) {
      await sendWebhookNotification(
        webhookUrl,
        'Social Poster Notification',
        `Published: "${caption}" | Bsky: ${results.bsky?.success ? '✅' : '❌'}, X: ${results.x?.success ? '✅' : '❌'}`
      );
    }

    res.json({ success: true, results });
  } catch (err: any) {
    console.error('Publish general failure:', err);
    res.status(500).json({ error: err?.message || 'Publishing failure' });
  }
});

// 4. POST Endpoint to upload files manually directly onto user's Google Drive folder
app.post(['/api/drive/upload', '/api/drive/upload/'], apiLimiter, async (req, res) => {
  const { fileName, mimeType, base64Data, parentFolderId, gdriveToken } = req.body;

  if (!base64Data || !parentFolderId) {
    return res.status(400).json({ error: 'Missing base64Data or parentFolderId' });
  }

  try {
    const rawBase64 = base64Data.split(',')[1] || base64Data;
    const mediaBuffer = Buffer.from(rawBase64, 'base64');

    const createUrl = 'https://www.googleapis.com/drive/v3/files';
    const { response: metadataResponse, usedToken } = await fetchDriveWithFallback(
      createUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fileName || 'uploaded_content.jpg',
          parents: [parentFolderId],
          mimeType: mimeType || 'image/jpeg',
        }),
      },
      gdriveToken
    );

    if (!metadataResponse.ok) {
      throw new Error(`Google Drive metadata creation failed: ${metadataResponse.statusText}`);
    }

    const fileNode: any = await metadataResponse.json();
    const createdFileId = fileNode.id;

    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${createdFileId}?uploadType=media`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${usedToken}`,
        'Content-Type': mimeType || 'image/jpeg',
      },
      body: mediaBuffer,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Google Drive binary upload failed: ${uploadResponse.statusText}`);
    }

    res.json({
      success: true,
      fileId: createdFileId,
    });
  } catch (error: any) {
    console.error('Drive upload exception:', error);
    res.status(500).json({ error: error?.message || 'Failed uploading file to GDrive' });
  }
});

// 5. POST Endpoint to move file inside Google Drive
app.post(['/api/drive/move-file', '/api/drive/move-file/'], apiLimiter, async (req, res) => {
  const { fileId, parentFolderId, destinationFolderName, gdriveToken } = req.body;

  if (!fileId || !parentFolderId || !destinationFolderName) {
    return res.status(400).json({ error: 'Missing fileId, parentFolderId, or destinationFolderName' });
  }

  try {
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${destinationFolderName}'+and+'${parentFolderId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id)`;
    const { response: searchRes, usedToken } = await fetchDriveWithFallback(searchUrl, {}, gdriveToken);

    let targetFolderId = '';
    const searchResult: any = await searchRes.json();

    if (searchResult.files && searchResult.files.length > 0) {
      targetFolderId = searchResult.files[0].id;
    } else {
      const createUrl = 'https://www.googleapis.com/drive/v3/files';
      const cRes = await fetch(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${usedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: destinationFolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId],
        }),
      });

      if (!cRes.ok) {
        throw new Error(`Failed to create subfolder named '${destinationFolderName}': ${cRes.statusText}`);
      }

      const createdFolder: any = await cRes.json();
      targetFolderId = createdFolder.id;
    }

    const infoUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`;
    const infoRes = await fetch(infoUrl, {
      headers: { Authorization: `Bearer ${usedToken}` },
    });

    let oldParentId = parentFolderId;
    if (infoRes.ok) {
      const info: any = await infoRes.json();
      if (info.parents && info.parents.length > 0) {
        oldParentId = info.parents[0];
      }
    }

    const moveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}&removeParents=${oldParentId}`;
    const moveRes = await fetch(moveUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${usedToken}` },
    });

    if (!moveRes.ok) {
      throw new Error(`Failed moving file to folder '${destinationFolderName}': ${moveRes.statusText}`);
    }

    res.json({ success: true, movedFileId: fileId, destinationFolderId: targetFolderId });
  } catch (error: any) {
    console.error('Failed moving GDrive file:', error);
    res.status(500).json({ error: error?.message || 'Failed moving Drive file' });
  }
});

// Configure Vite or Static folders depending on NODE_ENV
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
  });
}

// Export the Express app as a Firebase Cloud Function
export const api = onRequest(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  app
);

// Export 24/7 Cloud Scheduler function to check expired timers and send Chrome push notifications
export const scheduledDrivePoll = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeoutSeconds: 180,
    memory: '512MiB',
  },
  async () => {
    const db = getAdminDb();
    const now = Date.now();
    const activeUsersSnap = await db
      .collection('users')
      .where('isPollingActive', '==', true)
      .get();

    for (const userDoc of activeUsersSnap.docs) {
      const uid = userDoc.id;
      const config = userDoc.data();
      if (!config?.driveFolderId || !config?.nextPostTime || now < config.nextPostTime) {
        continue;
      }

      try {
        await pollDriveAndDraftForUser(uid, config);
      } catch (err: any) {
        console.error(`Scheduled poll failed for user ${uid}:`, err);
        await appendUserLog(
          uid,
          'error',
          `Background scheduler error: ${err?.message || err}`
        ).catch(() => {});
      }
    }
  }
);

// Only start the Express listener during local standalone development
if (!process.env.FIREBASE_CONFIG) {
  startServer();
}
