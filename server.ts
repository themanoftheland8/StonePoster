import express from 'express';
import path from 'path';
import cors from 'cors';
import { onRequest } from 'firebase-functions/v2/https';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';

import fs from 'fs';

dotenv.config();


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

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request Logging Middleware for auditing incoming requests
app.use((req, res, next) => {
  const line = `[${new Date().toISOString()}] ${req.method} ${req.path} - Headers: ${JSON.stringify(req.headers)}\n`;
  try {
    fs.appendFileSync(path.join(process.cwd(), 'requests.log'), line);
  } catch (e) {
    console.error('Failed to write to requests.log', e);
  }
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  next();
});

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

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
      return parsed.map(item => String(item));
    }
    throw new Error("Response was not a JSON array");
  } catch (err) {
    console.error("Failed to parse Gemini response as JSON. Text was:", text);
    // Fallback split
    return [
      "✨ Captivating photo choice! Check this out on our channels.",
      "🚀 Elevating our content with beautiful visual compositions.",
      "🌟 A brand new visual story just posted. What do you think?"
    ];
  }
}

// 1. POST Endpoint to fetch and caption photo/video from Google Drive
app.post(['/api/posts/analyze-gdrive', '/api/posts/analyze-gdrive/'], async (req, res) => {
  const { fileId, mimeType, gdriveToken } = req.body;

  if (!fileId || !gdriveToken) {
    return res.status(400).json({ error: 'Missing fileId or Google Drive accessToken' });
  }

  try {
    // A. Download file from Google Drive
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const downloadRes = await fetch(driveUrl, {
      headers: {
        Authorization: `Bearer ${gdriveToken}`,
      },
    });

    if (!downloadRes.ok) {
      throw new Error(`Failed to download from Drive: ${downloadRes.statusText}`);
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString('base64');
    const safeMimeType = mimeType || 'image/jpeg';

    // B. Analyze with Gemini 3.5 Flash
    const prompt = `Analyze this image or video content and generate exactly 3 distinct, compelling, and ready-to-post social media captions/texts suitable for X/Twitter & Bluesky sharing.
    Include relevant sparse hashtags/emojis if you want.
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

    // Formulate a compact preview image URL for the front-end (especially videos or huge images)
    let returnedImageUrl = `data:${safeMimeType};base64,${base64Data}`;

    if (safeMimeType.startsWith('video/')) {
      try {
        // Query Google Drive for the thumbnail of this video file
        const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`;
        const metaRes = await fetch(metaUrl, {
          headers: { Authorization: `Bearer ${gdriveToken}` },
        });
        if (metaRes.ok) {
          const metaJson: any = await metaRes.json();
          if (metaJson.thumbnailLink) {
            // Google Drive's thumbnailLink contains a public, fast CDN image proxy
            const thumbRes = await fetch(metaJson.thumbnailLink);
            if (thumbRes.ok) {
              const thumbBuf = await thumbRes.arrayBuffer();
              returnedImageUrl = `data:image/jpeg;base64,${Buffer.from(thumbBuf).toString('base64')}`;
            }
          }
        }
      } catch (thumbErr) {
        console.error('Google Drive thumbnail retrieval warning:', thumbErr);
      }

      // If resolving the thumbnail fails, fall back to an elegant, stylized SVG playback card
      if (returnedImageUrl.startsWith('data:video/')) {
        returnedImageUrl = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="100%" height="100%" fill="%231c1917"/><circle cx="300" cy="200" r="40" fill="%23eab308"/><polygon points="288,180 320,200 288,220" fill="%230c0a09"/><text x="300" y="280" fill="%23f5f5f4" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle">Video Preview Ready</text><text x="300" y="310" fill="%2378716c" font-family="sans-serif" font-size="12" text-anchor="middle">Short clip scanned by Gemini</text></svg>`;
      }
    }

    res.json({
      success: true,
      captions,
      imageUrl: returnedImageUrl,
    });

  } catch (error: any) {
    console.error('Error analyzing GDrive file:', error);
    res.status(500).json({ error: error?.message || 'Failed to download or analyze with Gemini' });
  }
});

// 2. POST Endpoint to analyze manual upload
app.post(['/api/posts/analyze-upload', '/api/posts/analyze-upload/'], async (req, res) => {
  const { fileName, mimeType, base64Data } = req.body;

  if (!base64Data) {
    return res.status(400).json({ error: 'Missing base64Data for analysis' });
  }

  try {
    const prompt = `Analyze this uploaded image and generate exactly 3 highly engaging social media captions suited for Twitter/X and Bluesky.
    Represent the content beautifully. Keep captions concise and optimized.
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
app.post(['/api/posts/publish', '/api/posts/publish/'], async (req, res) => {
  const {
    caption,
    imageUrl, // fully qualified data:image/jpeg;base64,...
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
        // 1. Session creation
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

        // 2. Upload blob if image present
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

        // 3. Create post record
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

    // C. Trigger smartphone notification webhook (e.g. Discord, slack or Ntfy.sh)
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `📢 Content Ready for Social Sharing! \n\n"${caption}"`,
            title: 'Social Poster Notification',
            message: `Selected caption is ready! Posting status: Bsky: ${results.bsky?.success ? '✅' : '❌'}, X: ${results.x?.success ? '✅' : '❌'}`,
          }),
        });
      } catch (webhookErr) {
        console.error('Webhook notification error:', webhookErr);
      }
    }

    res.json({ success: true, results });

  } catch (err: any) {
    console.error('Publish general failure:', err);
    res.status(500).json({ error: err?.message || 'Publishing failure' });
  }
});

// 4. POST Endpoint to upload files manually directly onto user's Google Drive folder
app.post(['/api/drive/upload', '/api/drive/upload/'], async (req, res) => {
  const { fileName, mimeType, base64Data, parentFolderId, gdriveToken } = req.body;

  if (!base64Data || !gdriveToken || !parentFolderId) {
    return res.status(400).json({ error: 'Missing base64Data, gdriveToken or parentFolderId' });
  }

  try {
    const rawBase64 = base64Data.split(',')[1] || base64Data;
    const mediaBuffer = Buffer.from(rawBase64, 'base64');

    // Step 1: Create metadata node on GDrive
    const createUrl = 'https://www.googleapis.com/drive/v3/files';
    const metadataResponse = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gdriveToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: fileName || 'uploaded_content.jpg',
        parents: [parentFolderId],
        mimeType: mimeType || 'image/jpeg',
      }),
    });

    if (!metadataResponse.ok) {
      throw new Error(`Google Drive metadata creation failed: ${metadataResponse.statusText}`);
    }

    const fileNode = await metadataResponse.json();
    const createdFileId = fileNode.id;

    // Step 2: Upload media bytes
    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${createdFileId}?uploadType=media`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${gdriveToken}`,
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
app.post(['/api/drive/move-file', '/api/drive/move-file/'], async (req, res) => {
  const { fileId, parentFolderId, destinationFolderName, gdriveToken } = req.body;

  if (!fileId || !parentFolderId || !destinationFolderName || !gdriveToken) {
    return res.status(400).json({ error: 'Missing fileId, parentFolderId, destinationFolderName or gdriveToken' });
  }

  try {
    // A. Check if the subfolder (e.g. "posted" or "skipped") exists under parentFolderId
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${destinationFolderName}'+and+'${parentFolderId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id)`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${gdriveToken}` },
    });

    let targetFolderId = '';
    const searchResult = await searchRes.json();

    if (searchResult.files && searchResult.files.length > 0) {
      targetFolderId = searchResult.files[0].id;
    } else {
      // Create the folder
      const createUrl = 'https://www.googleapis.com/drive/v3/files';
      const cRes = await fetch(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gdriveToken}`,
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

      const createdFolder = await cRes.json();
      targetFolderId = createdFolder.id;
    }

    // B. Get the current parent folder ID of the file to remove it correctly
    const infoUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`;
    const infoRes = await fetch(infoUrl, {
      headers: { Authorization: `Bearer ${gdriveToken}` },
    });

    let oldParentId = parentFolderId;
    if (infoRes.ok) {
      const info = await infoRes.json();
      if (info.parents && info.parents.length > 0) {
        oldParentId = info.parents[0];
      }
    }

    // C. Move the file
    const moveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}&removeParents=${oldParentId}`;
    const moveRes = await fetch(moveUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${gdriveToken}` },
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
export const api = onRequest({
  cors: true,
  timeoutSeconds: 120,
  memory: '256MiB',
}, app);

// Only start the Express listener during local standalone development
if (!process.env.FIREBASE_CONFIG) {
  startServer();
}
