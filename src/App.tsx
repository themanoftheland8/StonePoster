/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  addDoc,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType } from './lib/firebase';
import { UserConfig, PostItem, LogItem } from './types';
import ConfigManager from './components/ConfigManager';
import ImageCropper from './components/ImageCropper';
import ManualUploadCard from './components/ManualUploadCard';
import { versionInfo } from './version';

import {
  Compass,
  Sparkles,
  Clock,
  Terminal,
  LogOut,
  Settings,
  HelpCircle,
  Play,
  RotateCw,
  History,
  CheckCircle,
  XCircle,
  Smartphone,
  Shield,
  BookOpen,
  Copy,
  AlertCircle,
  AlertTriangle,
  Crop,
  Eye,
  Share2,
  MessageSquare,
  Check,
} from 'lucide-react';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gdriveToken, setGdriveToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'logs' | 'config'>('dashboard');

  // Business States
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [activePost, setActivePost] = useState<PostItem | null>(null);

  // States for active draft review and photo cropping
  const [isCropping, setIsCropping] = useState(false);
  const [editedCaption, setEditedCaption] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (activePost) {
      const idx = activePost.captions.indexOf(activePost.selectedCaption);
      setSelectedIdx(idx !== -1 ? idx : 0);
      setEditedCaption(activePost.selectedCaption || activePost.captions[0] || '');
    }
  }, [activePost?.id]);

  // Loading/Spinners
  const [isPolling, setIsPolling] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Counter
  const [countdownStr, setCountdownStr] = useState<string>('Not Scheduled');

  // Custom Alert / Detailed Notification modal state
  const [customAlert, setCustomAlert] = useState<{
    type: 'success' | 'error' | 'info' | 'warning';
    title: string;
    message: string;
    technicalDetails?: string;
  } | null>(null);

  // Helper function to trigger beautiful, copyable full-scanned custom alerts
  const triggerAlert = (
    type: 'success' | 'error' | 'info' | 'warning',
    title: string,
    message: string,
    technicalDetails?: string
  ) => {
    setCustomAlert({ type, title, message, technicalDetails });
  };

  // Extract human-friendly error summary and separate out raw HTML block payloads
  const parseErrorDetails = (errMsg: string) => {
    let message = errMsg;
    let technicalDetails = '';

    const indexHtmlMarker = errMsg.indexOf('HTML block:');
    const nonJsonMarker = errMsg.indexOf('received non-JSON');
    
    if (indexHtmlMarker !== -1) {
      message = errMsg.substring(0, indexHtmlMarker).trim();
      technicalDetails = errMsg.substring(indexHtmlMarker).trim();
    } else if (nonJsonMarker !== -1) {
      message = errMsg.substring(0, nonJsonMarker).trim();
      technicalDetails = errMsg.substring(nonJsonMarker).trim();
    } else if (errMsg.length > 250) {
      message = errMsg.substring(0, 200) + '...';
      technicalDetails = errMsg;
    }
    return { message, technicalDetails };
  };

  // Diagnostic State for static hosting environments (e.g. static Firebase Hosting preventing express execution)
  const [hostingDiagnosticWarning, setHostingDiagnosticWarning] = useState<string | null>(null);

  // Helper to dynamically resolve full URL paths depending on hosting context and configurations
  const getApiUrl = (endpointPath: string): string => {
    if (endpointPath.startsWith('http')) return endpointPath;
    const pathPart = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;

    // 1. If user explicitly specified a custom backend URL, prioritize it
    if (config?.backendUrl && config.backendUrl.trim() !== '') {
      const base = config.backendUrl.trim().endsWith('/')
        ? config.backendUrl.trim().slice(0, -1)
        : config.backendUrl.trim();
      return `${base}${pathPart}`;
    }

    // 2. Defaults to relative route under normal development container or Firebase rewrite context
    return pathPart;
  };

  // Check backend health to verify if we are running in a static-only hosting environment
  useEffect(() => {
    const checkBackendHealth = async () => {
      try {
        const res = await fetch(getApiUrl('/api/health'));
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            setHostingDiagnosticWarning(
              'Your Firebase Cloud Functions backend has not been deployed yet. Active API requests are falling back to static hosting rewrites.'
            );
          } else {
            // Backend connected successfully! No warning needed.
            setHostingDiagnosticWarning(null);
          }
        } else {
          setHostingDiagnosticWarning(
            'The Express API backend cannot be reached. Verify that the server is running on port 3000.'
          );
        }
      } catch (err) {
        setHostingDiagnosticWarning(
          'API connection failed. The server backend is offline or inaccessible.'
        );
      }
    };
    checkBackendHealth();
  }, [config?.backendUrl]);

  // Configure Google OAuth provider with scopes
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive');

  // Monitor Authentication
  useEffect(() => {
    return onAuthStateChanged(auth, async (parsedUser) => {
      setLoading(true);
      if (parsedUser) {
        setUser(parsedUser);
        
        // Try resolving Drive token locally first
        const localToken = localStorage.getItem(`gdrive_token_${parsedUser.uid}`);
        if (localToken) {
          setGdriveToken(localToken);
        }

        // Load data for the authenticated session
        await handleSessionLoad(parsedUser);

        // Fetch user document from Firestore to sync Drive token & refresh token if present
        try {
          const uDoc = await getDoc(doc(db, `users/${parsedUser.uid}`));
          if (uDoc.exists()) {
            const data = uDoc.data();
            if (data.driveToken) {
              setGdriveToken(data.driveToken);
              localStorage.setItem(`gdrive_token_${parsedUser.uid}`, data.driveToken);
            }
            if (data.driveRefreshToken) {
              localStorage.setItem(`gdrive_refresh_token_${parsedUser.uid}`, data.driveRefreshToken);
            }
          }
        } catch (err) {
          console.error("Failed to sync Drive credentials from Firestore:", err);
        }
      } else {
        setUser(null);
        setGdriveToken(null);
        setConfig(null);
        setPosts([]);
        setLogs([]);
        setActivePost(null);
      }
      setLoading(false);
    });
  }, []);

  // Mobile Responsiveness Helper: Auto-scroll to phone simulator preview when a draft is active
  useEffect(() => {
    if (activePost && typeof window !== 'undefined' && window.innerWidth < 1024) {
      const element = document.getElementById('phone-simulator');
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    }
  }, [activePost]);

  // Update Countdown Timer for Scheduled post
  useEffect(() => {
    const handleInterval = () => {
      if (!config?.nextPostTime || !config.isPollingActive) {
        setCountdownStr('Polling Disabled');
        return;
      }
      const now = Date.now();
      const diff = config.nextPostTime - now;

      if (diff <= 0) {
        setCountdownStr('Auto-poll due now!');
        // Automatically poll if active and we want to emulate background execution
        triggerAutoPoll();
      } else {
        const h = Math.floor(diff / (1000 * 60 * 60));
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((diff % (1000 * 60)) / 1000);
        setCountdownStr(`${h}h ${m}m ${s}s`);
      }
    };

    handleInterval();
    const clock = setInterval(handleInterval, 1000);
    return () => clearInterval(clock);
  }, [config]);

  // Authenticate & Connect Drive Scope
  const handleLogin = async () => {
    try {
      setLoading(true);
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      
      if (credential?.accessToken) {
        setGdriveToken(credential.accessToken);
        
        // Save the Google Drive OAuth credentials securely in Firestore.
        // We capture the OAuth credentials (access token and optionally refresh token)
        // and store them under the user's document for persistence.
        const tokenData: any = {
          driveToken: credential.accessToken,
          driveTokenExpiresAt: Date.now() + 3500 * 1000, // Google tokens typically expire in 1 hour
          updatedAt: Date.now(),
        };

        // If a refresh token is returned by the Google Provider, store it as well
        const rawCred = (credential as any)._tokenResponse;
        if (rawCred && rawCred.refreshToken) {
          tokenData.driveRefreshToken = rawCred.refreshToken;
        }

        await setDoc(doc(db, `users/${result.user.uid}`), tokenData, { merge: true });
        
        // Save locally to localStorage so it survives immediate session reloads
        localStorage.setItem(`gdrive_token_${result.user.uid}`, credential.accessToken);
        if (rawCred && rawCred.refreshToken) {
          localStorage.setItem(`gdrive_refresh_token_${result.user.uid}`, rawCred.refreshToken);
        }

        await createSystemLog(result.user.uid, 'success', 'Google user logged in & Drive scope token authorized and saved');
      }
    } catch (err) {
      console.error('Sign-in failure:', err);
    } finally {
      setLoading(false);
    }
  };

  // Terminate Auth Session
  const handleLogout = async () => {
    try {
      if (user) {
        localStorage.removeItem(`gdrive_token_${user.uid}`);
        localStorage.removeItem(`gdrive_refresh_token_${user.uid}`);
      }
      await auth.signOut();
    } catch (err) {
      console.error(err);
    }
  };

  // Create standard user trace log in Firestore
  const createSystemLog = async (uid: string, type: 'info' | 'success' | 'error', message: string) => {
    const logId = `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const logNode: LogItem = {
      id: logId,
      type,
      message,
      timestamp: Date.now(),
    };
    try {
      await setDoc(doc(db, `users/${uid}/logs`, logId), logNode);
      setLogs(prev => [logNode, ...prev].slice(0, 50));
    } catch (err) {
      console.error("Failed to append system log in Firestore:", err);
    }
  };

  // Create initial schedule time representation
  const getNextScheduledTime = (minH: number, maxH: number): number => {
    const minMs = minH * 60 * 60 * 1000;
    const maxMs = maxH * 60 * 60 * 1000;
    const randomOffset = Math.random() * (maxMs - minMs) + minMs;
    return Date.now() + Math.round(randomOffset);
  };

  // Read config, historical proposed posts and logs upon session bootstrap
  const handleSessionLoad = async (firebaseUser: User) => {
    const uid = firebaseUser.uid;
    const draftPath = `users/${uid}`;

    try {
      // 1. Config
      const configDoc = await getDoc(doc(db, draftPath));
      let currentConfig: UserConfig;

      if (!configDoc.exists()) {
        const defaultTime = getNextScheduledTime(2, 6);
        currentConfig = {
          driveFolderId: '1hsvMRVzXYXjadHot1PyV6jUEEKC9MeY4',
          minIntervalHours: 2,
          maxIntervalHours: 6,
          nextPostTime: defaultTime,
          isPollingActive: true,
          blueskyEnabled: false,
          twitterEnabled: false,
          webhookEnabled: false,
          backendUrl: '',
        };
        await setDoc(doc(db, draftPath), currentConfig);
        await createSystemLog(uid, 'info', 'System bootstrapped with default Google Drive folder locations');
      } else {
        currentConfig = configDoc.data() as UserConfig;
      }
      setConfig(currentConfig);

      // 2. Proposed Posts history
      const postsRef = collection(db, `${draftPath}/posts`);
      const postsSnap = await getDocs(postsRef);
      const postsList: PostItem[] = [];
      postsSnap.forEach(doc => {
        postsList.push(doc.data() as PostItem);
      });
      const sortedPosts = postsList.sort((a, b) => b.createdAt - a.createdAt);
      setPosts(sortedPosts);

      // See if we have an active proposed post with status 'pending_review'
      const activeDraft = sortedPosts.find(p => p.status === 'pending_review');
      if (activeDraft) {
        setActivePost(activeDraft);
      }

      // 3. User activity logs
      const logsRef = collection(db, `${draftPath}/logs`);
      const logsSnap = await getDocs(logsRef);
      const logsList: LogItem[] = [];
      logsSnap.forEach(doc => {
        logsList.push(doc.data() as LogItem);
      });
      setLogs(logsList.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50));

    } catch (error) {
      handleFirestoreError(error, OperationType.GET, draftPath);
    }
  };

  // Put / Update configuration settings
  const handleSaveConfig = async (newConfig: UserConfig) => {
    if (!user) return;
    setIsSavingConfig(true);
    const path = `users/${user.uid}`;
    try {
      // Preserve or calculate schedule
      const updatedConfig = {
        ...newConfig,
        nextPostTime: config?.nextPostTime || getNextScheduledTime(newConfig.minIntervalHours, newConfig.maxIntervalHours),
        updatedAt: Date.now(),
      };
      await setDoc(doc(db, path), updatedConfig);
      setConfig(updatedConfig);
      await createSystemLog(user.uid, 'success', 'Successfully updated server configurations & API integrations');
      setActiveTab('dashboard');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Downscale a base64 image data-URI using client-side canvas
  const downscaleBase64Image = (base64Str: string, maxDim = 1024, quality = 0.8): Promise<string> => {
    return new Promise((resolve) => {
      if (!base64Str || !base64Str.startsWith('data:image/')) {
        resolve(base64Str);
        return;
      }

      // If the base64 is already small enough, we can preserve it as-is if dimensions are fine.
      // But we must check that it is also short enough to fit Firestore.
      const isShortEnough = base64Str.length < 600000;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = base64Str;
      img.onload = () => {
        try {
          let width = img.width;
          let height = img.height;

          // If the image is already within acceptable dimension boundaries AND is short enough for Firestore, return it
          if (width <= maxDim && height <= maxDim && isShortEnough) {
            resolve(base64Str);
            return;
          }

          // Otherwise, calculate new scaled dimensions
          let targetMax = maxDim;
          if (base64Str.length > 2000000) {
            targetMax = Math.min(targetMax, 800);
          }

          if (width > targetMax || height > targetMax) {
            if (width > height) {
              height = Math.round((height * targetMax) / width);
              width = targetMax;
            } else {
              width = Math.round((width * targetMax) / height);
              height = targetMax;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(base64Str);
            return;
          }

          // Draw image on canvas (transparent background defaults to solid black/white on JPEG translation)
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          // Force JPEG compression to keep bytes tiny. Lossless PNG and WEBP ignore quality levels and bloat Firestore.
          let resBase64 = canvas.toDataURL('image/jpeg', quality);

          // Highly recursive/iterative fallback: if still exceeding a safe Firestore character capacity, step down
          let attempts = 0;
          let currentQuality = quality;
          let currentDim = targetMax;

          while (resBase64.length > 700000 && attempts < 3) {
            attempts++;
            currentQuality = Math.max(0.3, currentQuality - 0.2);
            currentDim = Math.round(currentDim * 0.75);

            let w = img.width;
            let h = img.height;
            if (w > h) {
              h = Math.round((h * currentDim) / w);
              w = currentDim;
            } else {
              w = Math.round((w * currentDim) / h);
              h = currentDim;
            }

            canvas.width = w;
            canvas.height = h;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resBase64 = canvas.toDataURL('image/jpeg', currentQuality);
          }

          // If standard JPEG format is somehow larger than raw input (e.g. extremely tiny image), keep the original
          if (resBase64.length < base64Str.length) {
            resolve(resBase64);
          } else if (isShortEnough) {
            resolve(base64Str);
          } else {
            // Force return the smaller one
            resolve(resBase64);
          }
        } catch (err) {
          console.error('Failed to downscale base64 image on canvas:', err);
          resolve(base64Str);
        }
      };
      img.onerror = () => {
        resolve(base64Str);
      };
    });
  };

  // Convert binary file content to base64 Data Url
  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  // Safe JSON parsing helper to raise readable, friendly errors instead of "Unexpected token <" HTML pages
  const safeFetchJson = async (res: Response, errorLabel: string): Promise<any> => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text();
      const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<!doctype') || text.trim().includes('<html') || text.trim().startsWith('<');
      if (isHtml) {
        throw new Error(`${errorLabel}: Server returned HTTP ${res.status} (${res.statusText}) HTML block: "${text.substring(0, 300).replace(/[\r\n]+/g, ' ')}"`);
      }
      throw new Error(`${errorLabel}: Expected JSON response, but received non-JSON (HTTP ${res.status}): ${text.substring(0, 150)}`);
    }
    try {
      const resClone = res.clone();
      return await resClone.json();
    } catch (parseErr: any) {
      throw new Error(`${errorLabel}: Failed to parse JSON response: ${parseErr.message}`);
    }
  };

  // Refresh Drive Access Token silently if expired using stored refresh token
  const getFreshDriveToken = async (): Promise<string | null> => {
    if (!user) return null;
    
    // Check if token exists in state
    if (gdriveToken) {
      // Check expiration if we saved it in Firestore
      try {
        const uDoc = await getDoc(doc(db, `users/${user.uid}`));
        if (uDoc.exists()) {
          const data = uDoc.data();
          // If token expires in less than 5 minutes, trigger silent refresh
          if (data.driveTokenExpiresAt && Date.now() < data.driveTokenExpiresAt - 300 * 1000) {
            return data.driveToken;
          }
        }
      } catch (e) {
        console.warn("Could not check token expiration from Firestore:", e);
      }
    }

    const refreshToken = localStorage.getItem(`gdrive_refresh_token_${user.uid}`);
    if (!refreshToken) {
      return gdriveToken;
    }

    try {
      const refreshRes = await fetch(getApiUrl('/api/auth/refresh-drive-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (refreshRes.ok) {
        const payload = await refreshRes.json();
        const newAccessToken = payload.accessToken;
        
        if (newAccessToken) {
          setGdriveToken(newAccessToken);
          localStorage.setItem(`gdrive_token_${user.uid}`, newAccessToken);
          
          await setDoc(
            doc(db, `users/${user.uid}`),
            {
              driveToken: newAccessToken,
              driveTokenExpiresAt: Date.now() + (payload.expiresIn || 3600) * 1000,
              updatedAt: Date.now(),
            },
            { merge: true }
          );

          await createSystemLog(user.uid, 'info', 'Silently refreshed Google Drive session access token');
          return newAccessToken;
        }
      }
    } catch (err) {
      console.error("Silent token refresh request failed:", err);
    }

    return gdriveToken;
  };

  // Run auto-poll if countdown reaches 0 to mock automated background routine
  const triggerAutoPoll = async () => {
    if (!user || isPolling || isProcessing || !config?.isPollingActive) return;
    await createSystemLog(user.uid, 'info', 'Preset random interval has concluded. Triggering automated content pull...');
    await handlePollAndPickRandom();
  };

  // Manual Trigger: Scan configured Drive Location, randomly select file, draw captions
  const handlePollAndPickRandom = async () => {
    if (!user) return;
    
    // Always fetch/refresh token before execution
    const activeToken = await getFreshDriveToken();
    if (!activeToken) {
      await createSystemLog(user.uid, 'error', 'Google authentication token expired. Please re-authenticate.');
      triggerAlert('warning', 'Session Refresh Required', 'Please click Sign-in again to refresh your secure Google session and update your Drive authentication token.');
      return;
    }

    setIsPolling(true);
    await createSystemLog(user.uid, 'info', `Scanning Google Drive Location for assets: [${config?.driveFolderId}]`);

    try {
      // 1. Fetch file list under configured parent directory (include file size to prevent downloading huge files)
      const listUrl = `https://www.googleapis.com/drive/v3/files?q='${config?.driveFolderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=100`;
      const response = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });

      if (!response.ok) {
        throw new Error(`Google Drive returned error status: ${response.statusText}`);
      }

      const rawResult = await response.json();
      const items = rawResult.files || [];

      // Filter only image and short video kinds, and check size to avoid downloading files that are too large (e.g. max 15MB)
      const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
      const mediaItems = items.filter((f: any) => {
        const isSupportedType = f.mimeType.startsWith('image/') || f.mimeType.startsWith('video/');
        const isSizeAcceptable = !f.size || parseInt(f.size) <= MAX_FILE_SIZE_BYTES;
        return isSupportedType && isSizeAcceptable;
      });

      if (mediaItems.length === 0) {
        await createSystemLog(user.uid, 'info', 'No supportable image/video assets discovered in target folder');
        triggerAlert('info', 'No Compatible Assets Found', `We successfully scanned Drive Folder [${config?.driveFolderId}] but did not discover any image or short video files matching our 15MB size limit. Please verify the folder contains compatible files under 15MB.`);
        setIsPolling(false);
        return;
      }

      // Check which IDs we have already processed in our historical list
      const processedIds = new Set(posts.map(p => p.driveFileId));
      const unprocessedMedia = mediaItems.filter((m: any) => !processedIds.has(m.id));

      let selectedFile = null;
      if (unprocessedMedia.length > 0) {
        // Pick one at random from unprocessed files
        const randomIdx = Math.floor(Math.random() * unprocessedMedia.length);
        selectedFile = unprocessedMedia[randomIdx];
      } else {
        await createSystemLog(user.uid, 'info', 'All files in folder have been previously posted or skipped. Cycling random file selection...');
        const randomIdx = Math.floor(Math.random() * mediaItems.length);
        selectedFile = mediaItems[randomIdx];
      }

      await createSystemLog(user.uid, 'info', `Selected asset: '${selectedFile.name}' (${selectedFile.id}). Triggering Gemini visual captioning...`);
      setIsPolling(false);
      setIsProcessing(true);

      // 2. Send selected GDrive fileId to server for downloading & Gemini vision captions modeling
      const analyzeRes = await fetch(getApiUrl('/api/posts/analyze-gdrive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: selectedFile.id,
          mimeType: selectedFile.mimeType,
          gdriveToken: activeToken,
        }),
      });

      if (!analyzeRes.ok) {
        const errPayload = await safeFetchJson(analyzeRes, 'Server captioning pipeline failed').catch(e => ({ error: e.message }));
        throw new Error(errPayload.error || 'Server captioning pipeline failed');
      }

      const analyzedOutput = await safeFetchJson(analyzeRes, 'Failed to extract captions content');
      const generatedCaptions = analyzedOutput.captions;
      let fileUrlData = analyzedOutput.imageUrl;

      // Downscale image if too large (e.g. from high resolution Drive sync) before saving to Firestore
      if (fileUrlData.startsWith('data:image/')) {
        fileUrlData = await downscaleBase64Image(fileUrlData);
      }

      // 3. Register proposed post drafted in Firestore
      const newPostId = `post_${Date.now()}`;
      const newPostNode: PostItem = {
        id: newPostId,
        driveFileId: selectedFile.id,
        fileName: selectedFile.name,
        mimeType: selectedFile.mimeType,
        imageUrl: fileUrlData,
        captions: generatedCaptions,
        selectedCaption: generatedCaptions[0] || '',
        status: 'pending_review',
        createdAt: Date.now(),
      };

      await setDoc(doc(db, `users/${user.uid}/posts`, newPostId), newPostNode);
      setPosts(prev => [newPostNode, ...prev]);
      setActivePost(newPostNode);

      // Trigger Webhook notification to send phone alert
      if (config?.webhookEnabled && config?.webhookUrl) {
        await fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🔔 New Media Proposed: "${selectedFile.name}"! Click review inside poster app.`,
            title: 'Social Poster Review',
            message: `Three caption alternatives ready for edits!`,
          }),
        });
      }

      await createSystemLog(user.uid, 'success', `Generated 3 custom captions for photo: '${selectedFile.name}'! Notification sent to phone.`);

    } catch (err: any) {
      console.error(err);
      await createSystemLog(user.uid, 'error', `Polling event error: ${err.message || err}`);
      const { message, technicalDetails } = parseErrorDetails(err.message || String(err));
      triggerAlert('error', 'Captioning Polling Failure', message, technicalDetails);
    } finally {
      setIsPolling(false);
      setIsProcessing(false);
    }
  };

  // Crop Photo: Update both Firestore and local state with the cropped image Data URL
  const handleCropSave = async (croppedDataUrl: string) => {
    if (!activePost || !user) return;
    setIsCropping(false);

    const updatedNode: PostItem = {
      ...activePost,
      imageUrl: croppedDataUrl,
    };

    try {
      await setDoc(doc(db, `users/${user.uid}/posts`, activePost.id), updatedNode);
      setPosts(prev => prev.map(p => (p.id === activePost.id ? updatedNode : p)));
      setActivePost(updatedNode);
      await createSystemLog(user.uid, 'success', `Cropped photo '${activePost.fileName}' successfully.`);
    } catch (err: any) {
      console.error(err);
      await createSystemLog(user.uid, 'error', `Failed saving cropped photo: ${err.message || err}`);
      triggerAlert('error', 'Cropping Save Failed', err.message || String(err));
    }
  };

  // Manual Local File Selection: Mirror the full Google Drive upload workflow!
  const handleManualUploadFlow = async (file: File) => {
    if (!user) return;
    
    const activeToken = await getFreshDriveToken();
    if (!activeToken) {
      triggerAlert('warning', 'Google Authentication Expected', 'Please connect Google Drive by signing in first.');
      return;
    }

    setIsProcessing(true);
    await createSystemLog(user.uid, 'info', `Uploading file '${file.name}' to Google Drive parent directory: [${config?.driveFolderId}]`);

    // Guard manual uploads against extremely large files that exceed proxy / browser limits
    const MAX_MANUAL_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_MANUAL_SIZE_BYTES) {
      triggerAlert('warning', 'File Size Limit Exceeded', `The selected file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Please upload a file smaller than 10MB to optimize performance and prevent gateway timeouts.`);
      setIsProcessing(false);
      return;
    }

    try {
      let base64Data = await convertFileToBase64(file);

      // Downscale image if too large before uploading to keep network payload small and avoid gateway timeouts
      if (file.type.startsWith('image/')) {
        base64Data = await downscaleBase64Image(base64Data);
      }

      // 1. Upload onto GDrive through Express middleware
      const uploadRes = await fetch(getApiUrl('/api/drive/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          base64Data,
          parentFolderId: config?.driveFolderId,
          gdriveToken: activeToken,
        }),
      });

      if (!uploadRes.ok) {
        const errPayload = await safeFetchJson(uploadRes, 'Upload endpoint failed').catch(() => ({}));
        throw new Error(errPayload.error || 'Failed to upload manual file to Google Drive directory');
      }

      const uploadResult = await safeFetchJson(uploadRes, 'Upload format parsing failed');
      const driveFileId = uploadResult.fileId;
      await createSystemLog(user.uid, 'success', `Successfully mirrored file to Google Drive. GDrive ID: ${driveFileId}`);

      // 2. Analyze the uploaded content using the common GDrive pipeline
      const analyzeRes = await fetch(getApiUrl('/api/posts/analyze-gdrive'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: driveFileId,
          mimeType: file.type,
          gdriveToken: activeToken,
        }),
      });

      if (!analyzeRes.ok) {
        const errPayload = await safeFetchJson(analyzeRes, 'Analyze endpoint failed').catch(() => ({}));
        throw new Error(errPayload.error || 'Gemini caption analysis failed for uploaded file');
      }

      const analyzedOutput = await safeFetchJson(analyzeRes, 'Analyze format parsing failed');
      const generatedCaptions = analyzedOutput.captions;
      let imageUrl = analyzedOutput.imageUrl;

      // Downscale returning analyze image if it is too massive before committing to Firestore
      if (imageUrl.startsWith('data:image/')) {
        imageUrl = await downscaleBase64Image(imageUrl);
      }

      // 3. Save into user posts history
      const newPostId = `post_${Date.now()}`;
      const newPostNode: PostItem = {
        id: newPostId,
        driveFileId: driveFileId,
        fileName: file.name,
        mimeType: file.type,
        imageUrl: imageUrl,
        captions: generatedCaptions,
        selectedCaption: generatedCaptions[0],
        status: 'pending_review',
        createdAt: Date.now(),
      };

      await setDoc(doc(db, `users/${user.uid}/posts`, newPostId), newPostNode);
      setPosts(prev => [newPostNode, ...prev]);
      setActivePost(newPostNode);

      await createSystemLog(user.uid, 'success', `Manual file caption completed. Asset saved for scheduling.`);

    } catch (err: any) {
      console.error(err);
      await createSystemLog(user.uid, 'error', `Manual upload failure: ${err.message || err}`);
      const { message, technicalDetails } = parseErrorDetails(err.message || String(err));
      triggerAlert('error', 'Local Upload Pipeline Failed', message, technicalDetails);
    } finally {
      setIsProcessing(false);
    }
  };

  // Re-run Gemini on current picture to get another 3 options
  const handleRegenerateCaptions = async () => {
    if (!activePost || !user) return;
    setIsRegenerating(true);
    await createSystemLog(user.uid, 'info', `Regenerating caption variants for active asset: '${activePost.fileName}'`);

    try {
      const reRes = await fetch(getApiUrl('/api/posts/analyze-upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: activePost.fileName,
          mimeType: activePost.mimeType,
          base64Data: activePost.imageUrl,
        }),
      });

      if (!reRes.ok) {
        const errPayload = await safeFetchJson(reRes, 'Regenerate API failed').catch(() => ({}));
        throw new Error(errPayload.error || 'Gemini API failed during caption regeneration');
      }

      const resultData = await safeFetchJson(reRes, 'Regenerate content parsing failed');

      // Update post registry
      const updatedNode: PostItem = {
        ...activePost,
        captions: resultData.captions,
        selectedCaption: resultData.captions[0],
      };

      await setDoc(doc(db, `users/${user.uid}/posts`, activePost.id), updatedNode);
      setPosts(prev => prev.map(p => (p.id === activePost.id ? updatedNode : p)));
      setActivePost(updatedNode);

      await createSystemLog(user.uid, 'success', 'Successfully regenerated 3 fresh caption alternatives!');

    } catch (err: any) {
      console.error(err);
      const { message, technicalDetails } = parseErrorDetails(err.message || String(err));
      triggerAlert('error', 'Caption Regeneration Failed', message, technicalDetails);
    } finally {
      setIsRegenerating(false);
    }
  };

  // Update selected caption in active memory
  const handleSelectCaption = (caption: string) => {
    if (activePost) {
      setActivePost(prev => prev ? { ...prev, selectedCaption: caption } : null);
    }
  };

  // Post the chosen photo + caption on configured active social platforms (Bsky + Twitter)
  const handlePublishContent = async (finalCaption: string) => {
    if (!activePost || !user) return;
    const confirmed = window.confirm("Publish this content directly on active social media channels (X and Bluesky)?");
    if (!confirmed) return;

    setIsPublishing(true);
    await createSystemLog(user.uid, 'info', `Publishing visual asset with caption: "${finalCaption}"`);

    try {
      const publishRes = await fetch(getApiUrl('/api/posts/publish'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption: finalCaption,
          imageUrl: activePost.imageUrl,
          bluesky: {
            enabled: config?.blueskyEnabled,
            username: config?.blueskyUsername,
            password: config?.blueskyPassword,
          },
          twitter: {
            enabled: config?.twitterEnabled,
            apiKey: config?.twitterApiKey,
            apiSecret: config?.twitterApiSecret,
            accessToken: config?.twitterAccessToken,
            accessSecret: config?.twitterAccessSecret,
          },
          webhookUrl: config?.webhookEnabled ? config?.webhookUrl : undefined,
        }),
      });

      if (!publishRes.ok) {
        const errPayload = await safeFetchJson(publishRes, 'Publishing endpoint failed').catch(() => ({}));
        throw new Error(errPayload.error || 'Social posting node request failed');
      }

      const publishResult = await safeFetchJson(publishRes, 'Publish outcome parsing failed');

      // Create detailed output logger
      const bskyOutcome = publishResult.results.bsky;
      const twitterOutcome = publishResult.results.x;

      let logMsg = `Publish Complete! \n`;
      if (config?.blueskyEnabled) {
        logMsg += `Bluesky: ${bskyOutcome?.success ? '✅ Success' : `❌ Error: ${bskyOutcome?.error}`} \n`;
      }
      if (config?.twitterEnabled) {
        logMsg += `X/Twitter: ${twitterOutcome?.success ? '✅ Success' : `❌ Error: ${twitterOutcome?.error}`} \n`;
      }

      await createSystemLog(user.uid, 'success', logMsg);

      // Now move file inside Drive under "posted" folder
      // Now move file inside Drive under "posted" folder
      if (activePost.driveFileId) {
        const activeToken = await getFreshDriveToken();
        if (activeToken) {
          await createSystemLog(user.uid, 'info', `Moving Google Drive file ${activePost.driveFileId} to 'posted' subfolder...`);
          const moveRes = await fetch(getApiUrl('/api/drive/move-file'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileId: activePost.driveFileId,
              parentFolderId: config?.driveFolderId,
              destinationFolderName: 'posted',
              gdriveToken: activeToken,
            }),
          });
          if (moveRes.ok) {
            await createSystemLog(user.uid, 'info', 'Google Drive file archiving completed successfully.');
          }
        }
      }

      // Finalize post record status to posted
      const updatedNode: PostItem = {
        ...activePost,
        selectedCaption: finalCaption,
        status: 'posted',
        postedAt: Date.now(),
      };

      await setDoc(doc(db, `users/${user.uid}/posts`, activePost.id), updatedNode);
      setPosts(prev => prev.map(p => (p.id === activePost.id ? updatedNode : p)));
      setActivePost(null);

      // Schedule next polling sequence
      if (config) {
        const nextTime = getNextScheduledTime(config.minIntervalHours, config.maxIntervalHours);
        const updatedConfig = { ...config, nextPostTime: nextTime };
        await setDoc(doc(db, `users/${user.uid}`), updatedConfig);
        setConfig(updatedConfig);
        await createSystemLog(user.uid, 'info', `Rescheduled next automated polling loop for: ${new Date(nextTime).toLocaleTimeString()}`);
      }

      triggerAlert('success', 'Asset Published', 'Your chosen caption alternative has been successfully synchronized and broadcast to social channels, and the Google Drive file compiled.');

    } catch (err: any) {
      console.error(err);
      await createSystemLog(user.uid, 'error', `Publish execution failure: ${err.message}`);
      const { message, technicalDetails } = parseErrorDetails(err.message || String(err));
      triggerAlert('error', 'Publishing Pipeline Failed', message, technicalDetails);
    } finally {
      setIsPublishing(false);
    }
  };

  // Skip proposal: archive directly to 'skipped' subdirectory
  const handleSkipProposal = async () => {
    if (!activePost || !user) return;
    const confirmed = window.confirm("Skip this visual draft and move into 'skipped' folder?");
    if (!confirmed) return;

    await createSystemLog(user.uid, 'info', `Skipping draft: '${activePost.fileName}'`);

    try {
      if (activePost.driveFileId) {
        const activeToken = await getFreshDriveToken();
        if (activeToken) {
          await createSystemLog(user.uid, 'info', `Archiving Google Drive file to 'skipped' subfolder...`);
          await fetch(getApiUrl('/api/drive/move-file'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileId: activePost.driveFileId,
              parentFolderId: config?.driveFolderId,
              destinationFolderName: 'skipped',
              gdriveToken: activeToken,
            }),
          });
        }
      }

      const updatedNode: PostItem = {
        ...activePost,
        status: 'skipped',
        skippedAt: Date.now(),
      };

      await setDoc(doc(db, `users/${user.uid}/posts`, activePost.id), updatedNode);
      setPosts(prev => prev.map(p => (p.id === activePost.id ? updatedNode : p)));
      setActivePost(null);

      // Reset next schedule item
      if (config) {
        const nextTime = getNextScheduledTime(config.minIntervalHours, config.maxIntervalHours);
        const updatedConfig = { ...config, nextPostTime: nextTime };
        await setDoc(doc(db, `users/${user.uid}`), updatedConfig);
        setConfig(updatedConfig);
      }

      await createSystemLog(user.uid, 'success', 'Draft skipped successfully. Waiting for next schedule.');

    } catch (err: any) {
      console.error(err);
      const { message, technicalDetails } = parseErrorDetails(err.message || String(err));
      triggerAlert('error', 'Skip Proposal Archiving Failed', message, technicalDetails);
    }
  };

  // Quick setup view for first login
  const isFirstTimeLogin = config && !config.blueskyUsername && !config.twitterApiKey;

  return (
    <div className="min-h-screen bg-bg-dark text-text-main font-sans flex flex-col selection:bg-brand-gold/20 selection:text-brand-gold">
      
      {/* Absolute Header Menu */}
      <header className="sticky top-0 z-40 glass-premium border-b border-brand-gold/15 px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-gradient-to-tr from-brand-gold-dark via-brand-gold to-yellow-200 shadow-md shadow-brand-gold/15 flex items-center justify-center text-bg-dark font-display font-black text-xs sm:text-sm shrink-0">
            SCM
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display font-bold text-text-main tracking-tight text-xs sm:text-base md:text-lg truncate">StoneContentManager</h1>
              <span className="px-1.5 py-0.5 rounded-full bg-brand-gold/15 text-brand-gold text-[8px] sm:text-[9px] font-mono leading-none tracking-wider font-extrabold uppercase border border-brand-gold/30">
                {versionInfo.version}
              </span>
            </div>
            <p className="text-[8px] sm:text-[10px] text-brand-gold/75 font-mono uppercase tracking-wider font-semibold truncate">Automatic Polling & Gemini Vision Copywriting</p>
          </div>
        </div>

        {user && (
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs font-semibold text-text-main">{user.email}</span>
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-brand-gold">Active Operator</span>
            </div>
            
            <button
              onClick={handleLogout}
              className="p-1.5 sm:p-2 text-stone-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer"
              title="Terminate Secure Session"
            >
              <LogOut className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        )}
      </header>

      {hostingDiagnosticWarning && (
        <div className="bg-amber-950/40 border-b border-amber-500/20 px-4 py-3 text-xs text-amber-200">
          <div className="max-w-7xl mx-auto flex items-start gap-3 text-left">
            <Shield className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="text-amber-300 font-semibold block">Cloud Functions Backend Pending Deployment:</span>
              <p className="leading-relaxed text-amber-200/90 font-semibold">
                {hostingDiagnosticWarning}
              </p>
              <p className="text-[11px] text-amber-200/90 leading-relaxed">
                By default, static hosting rewrites all non-existent paths back to <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">index.html</code>. 
                This causes backend API routes (e.g. <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">/api/health</code>, <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">/api/drive/upload</code>) to return static HTML content instead of JSON payload.
              </p>
              <p className="text-[11px] text-amber-400/90">
                💡 <span className="font-semibold">How to resolve:</span> Open your terminal and run <strong className="text-amber-300">firebase deploy</strong>. 
                This compiles your server files and deploys both the frontend and the Express API as a Firebase Cloud Function.
              </p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20">
          <RotateCw className="w-8 h-8 text-brand-gold animate-spin mb-4" />
          <p className="text-sm font-semibold text-text-muted">Verifying secure keys...</p>
        </div>
      ) : !user ? (
        
        /* UNAUTHENTICATED LOGIN BOARD */
        <main className="flex-1 max-w-lg mx-auto w-full flex flex-col justify-center px-4 py-16">
          <div className="glass rounded-3xl p-8 shadow-2xl text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-brand-gold/10 text-brand-gold mx-auto flex items-center justify-center">
              <Compass className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-2">
              <h2 className="font-display font-bold text-text-main text-2xl tracking-tight">Content Pipeline Automation</h2>
              <p className="text-sm text-text-muted leading-relaxed px-2">
                Poll customized Google Drive repositories, draft engaging caption alternatives using Gemini Vision AI, and publish directly onto X/Twitter and Bluesky.
              </p>
            </div>

            <div className="bg-brand-gold/5 text-gold-200 p-4 rounded-2xl text-xs flex items-start gap-3 border border-brand-gold/20 text-left">
              <Shield className="w-4 h-4 text-brand-gold shrink-0 mt-0.5" />
              <p className="leading-relaxed text-text-muted">
                <strong className="text-brand-gold font-medium">Google Auth & Permissions:</strong> Sign-In configures secure, in-memory API interactions to traverse folder layouts and move processed images, with permission from your account. The platform protects your identity.
              </p>
            </div>

            {/* Custom Google Material Sign In Button */}
            <button
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-3 bg-[#111115] hover:bg-[#15151b] border border-brand-gold/15 shadow-sm rounded-xl py-3 px-4 text-sm font-semibold text-text-main active:bg-[#0a0a0c] transition-all font-sans cursor-pointer active-glow"
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Sign in with Google Account
            </button>
          </div>
        </main>
      ) : (
        
        /* AUTHENTICATED PANEL WORKSPACE */
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 space-y-6">
          
          {/* Welcome Alert for First Time logins */}
          {isFirstTimeLogin ? (
            <div className="glass border-brand-gold/40 p-6 shadow-md flex flex-col md:flex-row gap-5 items-center justify-between rounded-2xl">
              <div className="space-y-1">
                <h3 className="font-display font-medium text-lg text-brand-gold tracking-tight">🔧 Complete Social Keys Configuration</h3>
                <p className="text-xs text-text-muted leading-relaxed max-w-xl">
                  Welcome to your new Content Poster! Please define your API credentials for X/Twitter, Bluesky handles, and custom Google Drive locations right now so the automation engine can launch.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('config')}
                className="px-5 py-2.5 btn-gold font-bold text-xs rounded-xl hover:opacity-90 transition shrink-0 uppercase tracking-wider"
              >
                Go to Configuration Area
              </button>
            </div>
          ) : null}

          {/* Core Controls Rail */}
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between glass rounded-2xl p-4 shadow-sm">
            
            {/* Quick Status Bar */}
            <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-text-muted">
              <div className="flex items-center gap-2 border bg-black/30 rounded-xl px-3 py-1.5 border-brand-gold/10">
                <Clock className="w-4 h-4 text-brand-gold shrink-0" />
                <span>Next Auto-Poll: <strong className="text-text-main font-mono">{countdownStr}</strong></span>
              </div>
              <div className="flex items-center gap-2 border bg-black/30 rounded-xl px-3 py-1.5 border-brand-gold/10">
                <div className={`w-2 h-2 rounded-full ${config?.isPollingActive ? 'bg-amber-400 animate-ping' : 'bg-stone-600'}`} />
                <span>Scheduler: <strong className="text-text-main font-semibold">{config?.isPollingActive ? 'Online Running' : 'Standby'}</strong></span>
              </div>
              <div className="flex items-center gap-2 border bg-black/30 rounded-xl px-3 py-1.5 border-brand-gold/10 font-mono">
                <span>Targets:</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${config?.blueskyEnabled ? 'bg-brand-gold/20 text-brand-gold border border-brand-gold/15 font-bold' : 'bg-stone-800 text-stone-500'}`}>BSky</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${config?.twitterEnabled ? 'bg-text-main text-bg-dark border border-stone-700 font-bold' : 'bg-stone-800 text-stone-500'}`}>X</span>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex w-full sm:w-auto overflow-x-auto no-scrollbar scroll-smooth bg-[#111115] border border-brand-gold/10 p-1 rounded-xl shrink-0">
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer ${
                  activeTab === 'dashboard' ? 'bg-gradient-to-tr from-[#efe2b6] to-[#d4af37] text-stone-950 shadow-sm' : 'text-stone-400 hover:text-text-main'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" /> Dashboard Preview
              </button>
              <button
                onClick={() => setActiveTab('logs')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer ${
                  activeTab === 'logs' ? 'bg-gradient-to-tr from-[#efe2b6] to-[#d4af37] text-stone-950 shadow-sm' : 'text-stone-400 hover:text-text-main'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" /> System Logs
              </button>
              <button
                onClick={() => setActiveTab('config')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap cursor-pointer ${
                  activeTab === 'config' ? 'bg-gradient-to-tr from-[#efe2b6] to-[#d4af37] text-stone-950 shadow-sm' : 'text-stone-400 hover:text-text-main'
                }`}
              >
                <Settings className="w-3.5 h-3.5" /> Configure Integrations
              </button>
            </div>

          </div>

          {/* ACTIVE WORKSPACE AREA */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">

              {/* ── FEATURED DRAFT REVIEW PANEL ── shows at top when a draft is active */}
              {activePost ? (
                <div className="glass rounded-2xl overflow-hidden border border-brand-gold/25 shadow-xl">
                  {/* Panel header */}
                  <div className="flex items-center justify-between px-5 py-3 border-b border-brand-gold/15 bg-black/40">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="text-xs font-bold font-mono uppercase tracking-wider text-brand-gold">
                        Draft Pending Review
                      </span>
                      <span className="text-[10px] text-stone-500 font-mono truncate max-w-[160px] hidden sm:block">
                        — {activePost.fileName}
                      </span>
                    </div>
                    <button
                      onClick={() => setActivePost(null)}
                      className="text-[10px] text-stone-500 hover:text-stone-300 font-semibold transition cursor-pointer px-2 py-1 rounded-lg hover:bg-white/5"
                    >
                      Dismiss ✕
                    </button>
                  </div>

                  {/* Two-column body: photo left, controls right */}
                  <div className="flex flex-col md:flex-row">

                    {/* LEFT: Photo preview */}
                    <div className="relative md:w-1/2 bg-black flex items-center justify-center min-h-[260px] overflow-hidden">
                      <img
                        src={activePost.imageUrl}
                        alt={activePost.fileName}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-contain max-h-[480px]"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent pointer-events-none" />
                      {/* Crop button */}
                      {activePost.mimeType?.startsWith('image/') && (
                        <button
                          onClick={() => setIsCropping(true)}
                          className="absolute top-3 right-3 px-3 py-1.5 bg-black/70 hover:bg-black/90 backdrop-blur-sm border border-brand-gold/30 text-brand-gold text-[11px] font-bold rounded-lg flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <Crop className="w-3.5 h-3.5" /> Crop Photo
                        </button>
                      )}
                    </div>

                    {/* RIGHT: Caption controls */}
                    <div className="md:w-1/2 flex flex-col p-5 space-y-5 overflow-y-auto max-h-[480px] no-scrollbar">

                      {/* Caption Options */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-brand-gold flex items-center gap-1.5">
                            <Sparkles className="w-3 h-3" /> Caption Options
                          </span>
                          <button
                            onClick={handleRegenerateCaptions}
                            disabled={isRegenerating}
                            className="text-[10px] text-stone-400 hover:text-brand-gold font-semibold transition cursor-pointer disabled:opacity-50 flex items-center gap-1"
                          >
                            <RotateCw className={`w-3 h-3 ${isRegenerating ? 'animate-spin' : ''}`} />
                            {isRegenerating ? 'Regenerating...' : 'Regenerate All'}
                          </button>
                        </div>
                        <div className="space-y-2">
                          {activePost.captions.map((cap, i) => (
                            <div
                              key={i}
                              onClick={() => {
                                setSelectedIdx(i);
                                setEditedCaption(cap);
                                handleSelectCaption(cap);
                              }}
                              className={`p-3 rounded-xl border cursor-pointer transition ${
                                selectedIdx === i
                                  ? 'bg-brand-gold/10 border-brand-gold/50'
                                  : 'bg-black/30 border-stone-800 hover:border-brand-gold/30'
                              }`}
                            >
                              <div className="flex items-start gap-2.5">
                                <span className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition ${selectedIdx === i ? 'bg-brand-gold border-brand-gold' : 'border-stone-600'}`}>
                                  {selectedIdx === i && <Check className="w-2.5 h-2.5 text-stone-950" />}
                                </span>
                                <div className="min-w-0">
                                  <span className="text-[9px] text-brand-gold/70 font-bold font-mono block mb-0.5">OPTION {i + 1}</span>
                                  <p className="text-xs text-text-main leading-relaxed">{cap}</p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Caption editor */}
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-brand-gold flex items-center gap-1.5">
                          <MessageSquare className="w-3 h-3" /> Edit Caption
                        </label>
                        <textarea
                          value={editedCaption}
                          onChange={(e) => {
                            setEditedCaption(e.target.value);
                            handleSelectCaption(e.target.value);
                          }}
                          rows={4}
                          className="w-full bg-black/50 border border-brand-gold/15 focus:border-brand-gold/40 text-text-main text-xs rounded-xl px-4 py-3 outline-none resize-none transition font-sans placeholder:text-stone-600 focus:ring-1 focus:ring-brand-gold/20 leading-relaxed"
                          placeholder="Edit your caption before posting..."
                        />
                      </div>

                      {/* Action buttons */}
                      <div className="grid grid-cols-2 gap-3 pt-1">
                        <button
                          onClick={handleSkipProposal}
                          className="py-3 bg-stone-900 border border-stone-700 hover:border-red-500/40 hover:bg-red-950/20 text-stone-400 hover:text-red-400 text-xs font-bold rounded-xl transition cursor-pointer"
                        >
                          Skip Draft
                        </button>
                        <button
                          onClick={() => handlePublishContent(editedCaption)}
                          disabled={isPublishing}
                          className="py-3 btn-gold text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                          <Share2 className="w-4 h-4" />
                          {isPublishing ? 'Publishing...' : 'Publish Now'}
                        </button>
                      </div>
                      <p className="text-[10px] text-stone-600 text-center">Publishes simultaneously to X & Bluesky</p>

                    </div>
                  </div>
                </div>
              ) : (
                /* No active draft: subtle prompt banner */
                <div className="glass rounded-2xl p-5 flex flex-col sm:flex-row items-center gap-4 justify-between border border-brand-gold/10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-gold/10 text-brand-gold flex items-center justify-center shrink-0">
                      <Eye className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-text-main">No draft pending review</p>
                      <p className="text-xs text-text-muted">Poll your Drive folder or upload a photo below to get started.</p>
                    </div>
                  </div>
                  <button
                    onClick={handlePollAndPickRandom}
                    disabled={isPolling || isProcessing}
                    className="px-5 py-2.5 btn-gold font-bold text-xs rounded-xl disabled:opacity-50 transition shrink-0 cursor-pointer flex items-center gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {isPolling ? 'Scanning...' : 'Poll Drive Now'}
                  </button>
                </div>
              )}

              {/* ── ACTION HUB: Poll banner + Upload + History ── always shown below */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

                {/* Left: Upload */}
                <div className="lg:col-span-7">
                  <ManualUploadCard onUpload={handleManualUploadFlow} isProcessing={isProcessing} />
                </div>

                {/* Right: History */}
                <div className="lg:col-span-5">
                  <div className="glass rounded-2xl p-6 shadow-sm space-y-4">
                    <div className="flex items-center justify-between border-b border-brand-gold/10 pb-3">
                      <div className="flex items-center gap-2.5">
                        <History className="w-5 h-5 text-brand-gold" />
                        <h3 className="font-display font-medium text-text-main text-sm">Processed Assets</h3>
                      </div>
                      <span className="text-xs font-mono bg-black/40 text-brand-gold px-2.5 py-1 rounded-full border border-brand-gold/15">{posts.length} entries</span>
                    </div>

                    {posts.length === 0 ? (
                      <div className="py-10 text-center text-text-muted text-xs">
                        No posts processed yet.
                      </div>
                    ) : (
                      <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 no-scrollbar">
                        {posts.map((post) => (
                          <div
                            key={post.id}
                            className={`flex items-start gap-3 p-3 border rounded-xl transition cursor-pointer ${
                              activePost?.id === post.id
                                ? 'bg-brand-gold/10 border-brand-gold/40'
                                : 'bg-black/25 hover:bg-black/40 border-brand-gold/5 hover:border-brand-gold/15'
                            }`}
                            onClick={() => post.status === 'pending_review' ? setActivePost(post) : undefined}
                          >
                            <img
                              src={post.imageUrl}
                              alt={post.fileName}
                              referrerPolicy="no-referrer"
                              className="w-11 h-11 rounded-lg object-cover bg-stone-900 shrink-0 border border-brand-gold/10 mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              <h4 className="text-xs font-semibold text-text-main truncate">{post.fileName}</h4>
                              <p className="text-[10px] text-text-muted mt-1 leading-normal whitespace-pre-wrap">{post.selectedCaption || 'No caption...'}</p>
                            </div>
                            <div className="shrink-0 mt-0.5">
                              {post.status === 'posted' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/40 text-emerald-300 border border-emerald-500/30">
                                  <CheckCircle className="w-3 h-3" /> Posted
                                </span>
                              ) : post.status === 'skipped' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950/40 text-red-300 border border-red-500/30">
                                  <XCircle className="w-3 h-3" /> Skipped
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/40 text-amber-300 border border-amber-500/30">
                                  Review
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* Logs Tab */}
          {activeTab === 'logs' && (
            <div className="glass rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-brand-gold/10 pb-3">
                <div className="flex items-center gap-2.5">
                  <Terminal className="w-5 h-5 text-brand-gold" />
                  <h3 className="font-display font-medium text-text-main text-sm">System Log Terminal</h3>
                </div>
                <button
                  onClick={() => handleSessionLoad(user)}
                  className="p-1 px-2.5 bg-black/40 hover:bg-black/70 text-[10px] text-brand-gold font-bold border border-brand-gold/20 rounded-lg flex items-center gap-1 transition"
                >
                  <RotateCw className="w-3 h-3" /> Refresh logs
                </button>
              </div>

              <div className="bg-black/90 border border-brand-gold/10 rounded-xl p-4 font-mono text-[11px] text-slate-300 space-y-2 h-[450px] overflow-y-auto no-scrollbar">
                <div className="text-brand-gold border-b border-stone-900 pb-2 mb-2 flex justify-between font-bold">
                  <span>LOG CONSOLE READY</span>
                  <span>UTC TIME: {new Date().toISOString()}</span>
                </div>
                {logs.length === 0 ? (
                  <span className="text-slate-500">System idle... Waiting for scheduled trigger...</span>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="flex gap-2.5 py-1 border-b border-stone-900/60 leading-relaxed">
                      <span className="text-stone-500 shrink-0 select-none">
                        [{new Date(log.timestamp).toLocaleTimeString()}]
                      </span>
                      {log.type === 'success' && <span className="text-emerald-400 shrink-0 font-bold">[SUCCESS]</span>}
                      {log.type === 'error' && <span className="text-red-400 shrink-0 font-bold">[ERROR]</span>}
                      {log.type === 'info' && <span className="text-amber-400 shrink-0 font-bold">[INFO]</span>}
                      <span className="text-slate-200 flex-1 whitespace-pre-wrap">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Configuration Tab */}
          {activeTab === 'config' && config && (
            <ConfigManager
              config={config}
              onSave={handleSaveConfig}
              isLoading={isSavingConfig}
            />
          )}

        </main>
      )}

      {/* Footer system credit line */}
      <footer className="glass-premium border-t border-brand-gold/10 py-6 text-center text-xs text-text-muted mt-auto">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Enterprise edition • Sandbox Node running on Port 3000</span>
          <span className="font-mono text-[9px] sm:text-xs flex items-center gap-1.5 flex-wrap">
            <span>App Version: <strong className="text-brand-gold font-semibold">{versionInfo.version}</strong></span>
            <span className="text-brand-gold/40">•</span>
            <span>Commit: <strong className="text-brand-gold font-semibold">{versionInfo.sha}</strong></span>
            <span className="text-brand-gold/40">•</span>
            <span>Built: <strong className="text-brand-gold font-semibold">{versionInfo.timestamp}</strong></span>
          </span>
        </div>
      </footer>

      {/* Image Cropper Modal */}
      {isCropping && activePost?.imageUrl && (
        <ImageCropper
          imageUrl={activePost.imageUrl}
          onSave={handleCropSave}
          onCancel={() => setIsCropping(false)}
        />
      )}

      {/* Custom Expandable Toast / Alert Dialog */}
      {customAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm transition-all focus:outline-none" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') setCustomAlert(null); }}>
          <div className="w-full max-w-2xl bg-stone-900 border border-brand-gold/35 rounded-2xl overflow-hidden shadow-2xl relative flex flex-col max-h-[90vh]">
            
            {/* Header */}
            <div className={`px-6 py-4 flex items-center justify-between border-b shrink-0 ${
              customAlert.type === 'error' ? 'border-red-500/20 bg-red-950/20' :
              customAlert.type === 'warning' ? 'border-amber-500/20 bg-amber-950/20' :
              customAlert.type === 'success' ? 'border-emerald-500/20 bg-emerald-950/20' :
              'border-brand-gold/15 bg-black/40'
            }`}>
              <div className="flex items-center gap-3">
                {customAlert.type === 'error' && <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />}
                {customAlert.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
                {customAlert.type === 'success' && <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />}
                {customAlert.type === 'info' && <Shield className="w-5 h-5 text-brand-gold shrink-0" />}
                <h3 className="font-display font-bold text-sm tracking-tight text-text-main uppercase">
                  {customAlert.title}
                </h3>
              </div>
              <button
                onClick={() => setCustomAlert(null)}
                className="p-1 px-2 text-[10px] uppercase tracking-wider font-extrabold rounded bg-black/40 hover:bg-black/70 text-text-muted hover:text-text-main transition border border-brand-gold/5 hover:border-brand-gold/20"
              >
                Close (Esc)
              </button>
            </div>

            {/* Content Body */}
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              
              {/* Short User-Facing Diagnostic message */}
              <div className="text-sm font-medium text-text-main/90 leading-relaxed whitespace-pre-wrap">
                {customAlert.message}
              </div>

              {/* Special Note for Static Routing if warning/error is related */}
              {(customAlert.message?.includes('doctype html') || 
                customAlert.message?.includes('HTML block') || 
                customAlert.technicalDetails?.includes('doctype html') ||
                customAlert.technicalDetails?.includes('HTML block') ||
                customAlert.technicalDetails?.includes('index.html')) && (
                <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-500/20 space-y-2 text-[11px] leading-relaxed text-amber-200">
                  <p className="font-semibold text-amber-300">💡 Diagnostic Advisory for Static Hosting (Firebase):</p>
                  <p>
                    Firebase Hosting is a fully client-side static service and has access only to static build files (HTML/CSS/JS). 
                    Without a live database proxy rewrite or separate cloud functions deployment, requests to backend server APIs (<code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">/api/*</code>) will rewrite directly to your compiled <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">index.html</code> file.
                  </p>
                  <p className="font-semibold text-amber-300">How to solve this:</p>
                  <ul className="list-disc pl-4 space-y-1">
                    <li>Recommended: Access the application through your Google AI Studio <strong className="text-amber-300">Cloud Run Dev/Preview link</strong>, which runs the Node/TS backend server inside containerized sandboxes!</li>
                    <li>Or, connect/migrate Express routes to Firebase Functions rewrite.</li>
                  </ul>
                </div>
              )}

              {/* Technical Details / Expandable console-like block */}
              {customAlert.technicalDetails && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span className="font-mono text-[10px] tracking-wider uppercase">Full Server Response Log ({customAlert.technicalDetails.length} chars)</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(customAlert.technicalDetails || '');
                        alert('Full technical diagnostic log details copied to clipboard!');
                      }}
                      className="px-2 py-1 bg-black hover:bg-black/75 rounded border border-brand-gold/15 transition flex items-center gap-1 cursor-pointer text-brand-gold font-bold font-mono text-[9px]"
                    >
                      <Copy className="w-2.5 h-2.5" /> COPY RAW LOG
                    </button>
                  </div>
                  <div className="w-full h-48 overflow-auto rounded-xl bg-black border border-brand-gold/10 p-4 font-mono text-[10px] leading-relaxed text-red-300/90 whitespace-pre scrollbar-thin">
                    {customAlert.technicalDetails}
                  </div>
                </div>
              )}

            </div>

            {/* Bottom Actions */}
            <div className="px-6 py-4 bg-stone-900/60 border-t border-brand-gold/10 flex items-center justify-end gap-3 shrink-0">
              <button
                onClick={() => setCustomAlert(null)}
                className="px-5 py-2 hover:bg-white/5 text-text-muted hover:text-text-main text-xs font-bold rounded-xl transition cursor-pointer"
              >
                Acknowledge
              </button>
              {customAlert.technicalDetails && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`Title: ${customAlert.title}\nMessage: ${customAlert.message}\nDetails: ${customAlert.technicalDetails}`);
                    alert('Full Diagnostic context successfully saved to clipboard!');
                  }}
                  className="px-5 py-2 bg-brand-gold/15 hover:bg-brand-gold/25 border border-brand-gold/30 hover:border-brand-gold/50 text-brand-gold text-xs font-bold rounded-xl transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy Log
                </button>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
