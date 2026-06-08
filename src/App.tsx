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
import PhoneSimulator from './components/PhoneSimulator';
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

  // Loading/Spinners
  const [isPolling, setIsPolling] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // Counter
  const [countdownStr, setCountdownStr] = useState<string>('Not Scheduled');

  // Diagnostic State for static hosting environments (e.g. static Firebase Hosting preventing express execution)
  const [hostingDiagnosticWarning, setHostingDiagnosticWarning] = useState<string | null>(null);

  // Check backend health to verify if we are running in a static-only hosting environment
  useEffect(() => {
    const checkBackendHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            setHostingDiagnosticWarning(
              'Static-only hosting environment detected (Firebase Hosting). The required Node.js Express server is not running on this URL.'
            );
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
  }, []);

  // Configure Google OAuth provider with scopes
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive');

  // Monitor Authentication
  useEffect(() => {
    return onAuthStateChanged(auth, async (parsedUser) => {
      setLoading(true);
      if (parsedUser) {
        setUser(parsedUser);
        // Load data for the authenticated session
        await handleSessionLoad(parsedUser);
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
        await createSystemLog(result.user.uid, 'success', 'Google user logged in & Drive scope token authorized');
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
      if (!base64Str || !base64Str.startsWith('data:image/') || base64Str.length < 200000) {
        resolve(base64Str);
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = base64Str;
      img.onload = () => {
        try {
          let width = img.width;
          let height = img.height;

          if (width <= maxDim && height <= maxDim) {
            resolve(base64Str);
            return;
          }

          if (width > height) {
            if (width > maxDim) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            }
          } else {
            if (height > maxDim) {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
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

          ctx.drawImage(img, 0, 0, width, height);

          // Get original mime type
          const matchMime = base64Str.match(/data:([^;]+);/);
          const originalMime = matchMime ? matchMime[1] : 'image/jpeg';
          const outputMime = originalMime.includes('png') || originalMime.includes('webp') ? originalMime : 'image/jpeg';

          const resBase64 = canvas.toDataURL(outputMime, quality);
          if (resBase64.length < base64Str.length) {
            resolve(resBase64);
          } else {
            resolve(base64Str);
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

  // Run auto-poll if countdown reaches 0 to mock automated background routine
  const triggerAutoPoll = async () => {
    if (!user || isPolling || isProcessing || !config?.isPollingActive) return;
    await createSystemLog(user.uid, 'info', 'Preset random interval has concluded. Triggering automated content pull...');
    await handlePollAndPickRandom();
  };

  // Manual Trigger: Scan configured Drive Location, randomly select file, draw captions
  const handlePollAndPickRandom = async () => {
    if (!user) return;
    if (!gdriveToken) {
      await createSystemLog(user.uid, 'error', 'Google authentication token expired. Please re-authenticate.');
      alert('Please click Sign-in again to refresh your secure Google session.');
      return;
    }

    setIsPolling(true);
    await createSystemLog(user.uid, 'info', `Scanning Google Drive Location for assets: [${config?.driveFolderId}]`);

    try {
      // 1. Fetch file list under configured parent directory (include file size to prevent downloading huge files)
      const listUrl = `https://www.googleapis.com/drive/v3/files?q='${config?.driveFolderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,size)&pageSize=100`;
      const response = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${gdriveToken}` },
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
        alert(`We scanned Drive Folder [${config?.driveFolderId}] but found no image or video assets within our 15MB size limit. Please ensure your files are below 15MB each.`);
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
      const analyzeRes = await fetch('/api/posts/analyze-gdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: selectedFile.id,
          mimeType: selectedFile.mimeType,
          gdriveToken,
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
      if (selectedFile.mimeType.startsWith('image/')) {
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
      alert(`Error during scanning & Captioning: ${err.message || err}`);
    } finally {
      setIsPolling(false);
      setIsProcessing(false);
    }
  };

  // Manual Local File Selection: Mirror the full Google Drive upload workflow!
  const handleManualUploadFlow = async (file: File) => {
    if (!user) return;
    if (!gdriveToken) {
      alert('Please connect Google Drive by signing in first.');
      return;
    }

    setIsProcessing(true);
    await createSystemLog(user.uid, 'info', `Uploading file '${file.name}' to Google Drive parent directory: [${config?.driveFolderId}]`);

    // Guard manual uploads against extremely large files that exceed proxy / browser limits
    const MAX_MANUAL_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_MANUAL_SIZE_BYTES) {
      alert(`The selected file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Please upload a file smaller than 10MB to optimize performance and prevent gateway timeouts.`);
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
      const uploadRes = await fetch('/api/drive/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          base64Data,
          parentFolderId: config?.driveFolderId,
          gdriveToken,
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
      const analyzeRes = await fetch('/api/posts/analyze-gdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: driveFileId,
          mimeType: file.type,
          gdriveToken,
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
      if (file.type.startsWith('image/')) {
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
      alert(`Local Upload Pipeline failed: ${err.message}`);
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
      const reRes = await fetch('/api/posts/analyze-upload', {
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
      alert(`Regeneration failed: ${err.message}`);
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
      const publishRes = await fetch('/api/posts/publish', {
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
      if (activePost.driveFileId && gdriveToken) {
        await createSystemLog(user.uid, 'info', `Moving Google Drive file ${activePost.driveFileId} to 'posted' subfolder...`);
        const moveRes = await fetch('/api/drive/move-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: activePost.driveFileId,
            parentFolderId: config?.driveFolderId,
            destinationFolderName: 'posted',
            gdriveToken,
          }),
        });
        if (moveRes.ok) {
          await createSystemLog(user.uid, 'info', 'Google Drive file archiving completed successfully.');
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

      alert('Content published successfully!');

    } catch (err: any) {
      console.error(err);
      await createSystemLog(user.uid, 'error', `Publish execution failure: ${err.message}`);
      alert(`Sharing workflow failed: ${err.message}`);
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
      if (activePost.driveFileId && gdriveToken) {
        await createSystemLog(user.uid, 'info', `Archiving Google Drive file to 'skipped' subfolder...`);
        await fetch('/api/drive/move-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: activePost.driveFileId,
            parentFolderId: config?.driveFolderId,
            destinationFolderName: 'skipped',
            gdriveToken,
          }),
        });
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
      alert(`Failed skipping proposal: ${err?.message}`);
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
              <span className="text-amber-300 font-semibold block">Static-Only Routing Detected:</span>
              <p className="leading-relaxed text-amber-200/90">
                You are currently running the application on a static hosting service (Firebase Hosting). 
                Static hosts are designed for client-only files and, by default, rewrite backend API paths back to <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">index.html</code>. 
                This causes endpoints like <code className="bg-amber-950/60 px-1 py-0.5 rounded text-amber-300">/api/drive/upload</code> to return HTML content in HTTP 200 instead of a JSON response.
              </p>
              <p className="text-[11px] text-amber-400/90">
                💡 <span className="font-semibold">How to resolve:</span> Access the application using your authorized <strong className="text-amber-300">Cloud Run Dev Preview Link</strong> in Google AI Studio. 
                The Cloud Run Preview successfully hosts the full Node.js Express server to handle all server-side operations (Google Drive file writes, Gemini Vision prompts, and social publishing).
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
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              
              {/* Left Column: Action Hub */}
              <div className="lg:col-span-8 space-y-6">
                
                {/* Visual workflow banner */}
                <div className="glass-premium rounded-3xl p-6 text-white overflow-hidden relative shadow-lg">
                  <div className="absolute right-0 top-0 translate-x-12 -translate-y-6 opacity-5 blur-xl w-72 h-72 rounded-full bg-brand-gold" />
                  
                  <div className="relative space-y-3 max-w-lg">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-brand-gold font-mono flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-brand-gold" /> Auto-Scheduler Node
                    </span>
                    <h2 className="font-display font-medium text-2xl tracking-tight leading-none text-text-main sm:text-3xl">
                      Trigger Immediate Polling
                    </h2>
                    <p className="text-xs text-text-muted leading-relaxed">
                      Check your designated Google Drive folder space, download a random unposted photo/video, generate 3 smart caption ideas with Gemini 3.5, and alert your device!
                    </p>

                    <div className="pt-2 flex flex-wrap gap-2.5">
                      <button
                        onClick={handlePollAndPickRandom}
                        disabled={isPolling || isProcessing}
                        className="px-5 py-3 btn-gold font-bold text-xs rounded-xl disabled:opacity-50 transition duration-150 flex items-center gap-1.5 uppercase shadow-sm cursor-pointer"
                      >
                        {isPolling ? 'Scanning Drive...' : 'Poll & Pick Random File'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Manual Local Content Upload */}
                <ManualUploadCard onUpload={handleManualUploadFlow} isProcessing={isProcessing} />

                {/* Queue History */}
                <div className="glass rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-brand-gold/10 pb-3">
                    <div className="flex items-center gap-2.5">
                      <History className="w-5 h-5 text-brand-gold" />
                      <h3 className="font-display font-medium text-text-main text-sm">Processed Assets History</h3>
                    </div>
                    <span className="text-xs font-mono bg-black/40 text-brand-gold px-2.5 py-1 rounded-full border border-brand-gold/15">{posts.length} entries</span>
                  </div>

                  {posts.length === 0 ? (
                    <div className="py-12 text-center text-text-muted text-xs">
                      No posts processed yet. Scan Google Drive directory to make selections.
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1 no-scrollbar">
                      {posts.map((post) => (
                        <div
                          key={post.id}
                          className="flex items-center gap-4 p-3 bg-black/25 hover:bg-black/40 border border-brand-gold/5 hover:border-brand-gold/15 rounded-xl transition"
                        >
                          <img
                            src={post.imageUrl}
                            alt={post.fileName}
                            referrerPolicy="no-referrer"
                            className="w-12 h-12 rounded-lg object-cover bg-stone-900 shrink-0 border border-brand-gold/10"
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="text-xs font-semibold text-text-main truncate">{post.fileName}</h4>
                            <p className="text-[10px] text-text-muted truncate mt-0.5">{post.selectedCaption || 'No selected caption...'}</p>
                          </div>
                          
                          {/* Badge Status */}
                          <div className="shrink-0">
                            {post.status === 'posted' ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-950/40 text-emerald-300 border border-emerald-500/30">
                                <CheckCircle className="w-3 h-3 text-emerald-400" /> Posted
                              </span>
                            ) : post.status === 'skipped' ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-red-950/40 text-red-300 border border-red-500/30">
                                <XCircle className="w-3 h-3 text-red-400" /> Skipped
                              </span>
                            ) : (
                              <button
                                onClick={() => setActivePost(post)}
                                className="px-3 py-1 btn-gold-outline text-[10px] font-bold rounded-lg transition text-xs cursor-pointer"
                              >
                                Review Draft
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>

              {/* Right Column: Interactive Immersive Smartphone Preview */}
              <div className="lg:col-span-4 flex justify-center">
                <PhoneSimulator
                  activePost={activePost}
                  onSelectCaption={handleSelectCaption}
                  onRegenerate={handleRegenerateCaptions}
                  onPublish={handlePublishContent}
                  onSkip={handleSkipProposal}
                  isPublishing={isPublishing}
                  isRegenerating={isRegenerating}
                />
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

    </div>
  );
}
