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
  onSnapshot,
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
  isWebPushSupported,
  getCurrentPushSubscription,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  sendTestWebPush,
} from './lib/webPush';

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
  X,
  Zap,
  Bell,
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

  // 24/7 Service Account & Chrome Web Push states
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null);
  const [isThisDeviceSubscribed, setIsThisDeviceSubscribed] = useState(false);
  const [subscribedDeviceCount, setSubscribedDeviceCount] = useState(0);
  const [isPushBusy, setIsPushBusy] = useState(false);
  const autoPollLockRef = React.useRef(false);
  const triggerAutoPollRef = React.useRef<() => void>(() => {});
  const dismissedPostIdRef = React.useRef<string | null>(null);

  // Custom Alert / Detailed Notification modal state
  const [customAlert, setCustomAlert] = useState<{
    type: 'success' | 'error' | 'info' | 'warning';
    title: string;
    message: string;
    technicalDetails?: string;
  } | null>(null);

  // Non-blocking top banner for transient / rate-limit notifications
  const [notifBanner, setNotifBanner] = useState<{
    message: string;
    retryAt?: string;
  } | null>(null);
  const bannerTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerBanner = (message: string, retryAt?: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setNotifBanner({ message, retryAt });
    bannerTimerRef.current = setTimeout(() => setNotifBanner(null), 10000);
  };

  const dismissBanner = () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setNotifBanner(null);
  };

  // Detect rate-limit / quota errors from Gemini or other APIs
  const isRateLimitError = (msg: string): boolean => {
    const lower = msg.toLowerCase();
    return (
      lower.includes('rate limit') ||
      lower.includes('rate_limit') ||
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('too many requests') ||
      lower.includes('429') ||
      lower.includes('overloaded') ||
      lower.includes('model is overloaded') ||
      lower.includes('try again later')
    );
  };

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

  // Check backend health and load service account email for 24/7 Drive sharing
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
            try {
              const saRes = await fetch(getApiUrl('/api/drive/service-account'));
              if (saRes.ok) {
                const saData = await saRes.json();
                setServiceAccountEmail(saData.email || null);
              }
            } catch {
              // Non-fatal
            }
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

  // Check if this browser/device already has an active Chrome Web Push subscription
  useEffect(() => {
    if (!isWebPushSupported()) return;
    getCurrentPushSubscription()
      .then((sub) => setIsThisDeviceSubscribed(Boolean(sub)))
      .catch(() => setIsThisDeviceSubscribed(false));
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
        setSubscribedDeviceCount(0);
      }
      setLoading(false);
    });
  }, []);

  // Live Firestore subscriptions so background Cloud Scheduler updates appear immediately
  useEffect(() => {
    if (!user) return;
    const uid = user.uid;

    const unsubConfig = onSnapshot(doc(db, `users/${uid}`), (snap) => {
      if (snap.exists()) {
        setConfig(snap.data() as UserConfig);
      }
    });

    const unsubPosts = onSnapshot(collection(db, `users/${uid}/posts`), (snap) => {
      const postsList: PostItem[] = [];
      snap.forEach((d) => postsList.push(d.data() as PostItem));
      const sortedPosts = postsList.sort((a, b) => b.createdAt - a.createdAt);
      setPosts(sortedPosts);

      const pendingDraft = sortedPosts.find((p) => p.status === 'pending_review');
      if (pendingDraft) {
        setActivePost((prev) => {
          if (prev && prev.id === pendingDraft.id) return pendingDraft;
          if (dismissedPostIdRef.current === pendingDraft.id) return prev;
          return pendingDraft;
        });
      } else {
        setActivePost((prev) => (prev && prev.status === 'pending_review' ? null : prev));
      }
    });

    const unsubLogs = onSnapshot(collection(db, `users/${uid}/logs`), (snap) => {
      const logsList: LogItem[] = [];
      snap.forEach((d) => logsList.push(d.data() as LogItem));
      setLogs(logsList.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50));
    });

    const unsubPush = onSnapshot(collection(db, `users/${uid}/pushSubscriptions`), (snap) => {
      setSubscribedDeviceCount(snap.size);
    });

    return () => {
      unsubConfig();
      unsubPosts();
      unsubLogs();
      unsubPush();
    };
  }, [user?.uid]);

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
        triggerAutoPollRef.current();
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
  }, [config?.nextPostTime, config?.isPollingActive]);

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
          pushNotificationsEnabled: true,
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
      await setDoc(doc(db, path), updatedConfig, { merge: true });
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

  // Chrome Web Push subscription handlers
  const handleEnablePush = async () => {
    if (!user) return;
    setIsPushBusy(true);
    try {
      const idToken = await user.getIdToken();
      const { deviceLabel } = await subscribeToWebPush(getApiUrl, idToken);
      setIsThisDeviceSubscribed(true);
      await createSystemLog(user.uid, 'success', `Enabled Chrome push notifications on ${deviceLabel}`);
      triggerBanner(`Chrome notifications enabled on ${deviceLabel}! You'll be alerted even when the browser is closed.`);
    } catch (err: any) {
      console.error('Failed enabling Chrome push:', err);
      triggerAlert('warning', 'Chrome Notifications Setup', err?.message || String(err));
    } finally {
      setIsPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    if (!user) return;
    setIsPushBusy(true);
    try {
      const idToken = await user.getIdToken();
      await unsubscribeFromWebPush(getApiUrl, idToken);
      setIsThisDeviceSubscribed(false);
      await createSystemLog(user.uid, 'info', 'Disabled Chrome push notifications on this device');
      triggerBanner('Chrome push notifications disabled on this device.');
    } catch (err: any) {
      console.error('Failed disabling Chrome push:', err);
      triggerAlert('error', 'Failed Disabling Notifications', err?.message || String(err));
    } finally {
      setIsPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    if (!user) return;
    setIsPushBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await sendTestWebPush(getApiUrl, idToken);
      triggerBanner(`Test Chrome notification sent to ${res.sent} device(s)!`);
    } catch (err: any) {
      console.error('Failed sending test push:', err);
      triggerAlert('warning', 'Test Notification Failed', err?.message || String(err));
    } finally {
      setIsPushBusy(false);
    }
  };

  // Run auto-poll if countdown reaches 0 while tab is open (Cloud Scheduler also runs every 5m 24/7)
  const triggerAutoPoll = async () => {
    if (!user || isPolling || isProcessing || !config?.isPollingActive || autoPollLockRef.current) return;
    autoPollLockRef.current = true;

    try {
      // Skip polling if there is already a post waiting in the review queue.
      // Advance the schedule silently so the timer doesn't fire again immediately.
      const hasPendingPost = posts.some(p => p.status === 'pending_review');
      if (hasPendingPost) {
        const nextTime = getNextScheduledTime(config.minIntervalHours, config.maxIntervalHours);
        const updatedConfig = { ...config, nextPostTime: nextTime };
        await setDoc(doc(db, `users/${user.uid}`), updatedConfig, { merge: true });
        setConfig(updatedConfig);
        await createSystemLog(user.uid, 'info', `Auto-poll skipped — a post is already pending review. Rescheduled for: ${new Date(nextTime).toLocaleTimeString()}`);
        return;
      }

      // Advance the schedule immediately so the 1-second tick loop can't re-fire this.
      const nextTime = getNextScheduledTime(config.minIntervalHours, config.maxIntervalHours);
      const updatedConfig = { ...config, nextPostTime: nextTime };
      await setDoc(doc(db, `users/${user.uid}`), updatedConfig, { merge: true });
      setConfig(updatedConfig);

      await createSystemLog(user.uid, 'info', 'Preset random interval has concluded. Triggering automated content pull...');
      await handlePollAndPickRandom();
    } finally {
      autoPollLockRef.current = false;
    }
  };

  triggerAutoPollRef.current = triggerAutoPoll;

  // Manual or Scheduled Trigger: Run server-side Drive scan -> Gemini captions -> Firestore -> Chrome Push
  const handlePollAndPickRandom = async () => {
    if (!user) return;

    const activeToken = await getFreshDriveToken();
    setIsPolling(true);

    try {
      const idToken = await user.getIdToken();
      const pollRes = await fetch(getApiUrl('/api/posts/poll-now'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          gdriveToken: activeToken || undefined,
        }),
      });

      if (!pollRes.ok) {
        const errPayload = await safeFetchJson(pollRes, 'Server polling pipeline failed').catch(e => ({ error: e.message }));
        throw new Error(errPayload.error || 'Server polling pipeline failed');
      }

      const pollData = await safeFetchJson(pollRes, 'Failed parsing poll response');
      if (pollData.skipped && pollData.reason === 'no_media') {
        triggerAlert(
          'info',
          'No Compatible Assets Found',
          `We scanned Drive Folder [${config?.driveFolderId}] but did not discover any image or short video files under 15MB.`
        );
      } else if (pollData.skipped && pollData.reason === 'pending_review') {
        triggerBanner('A draft is already waiting for your review.');
      } else if (pollData.createdPostId) {
        dismissedPostIdRef.current = null;
        await handleSessionLoad(user);
      }
    } catch (err: any) {
      console.error(err);
      const rawMsg = err.message || String(err);
      await createSystemLog(user.uid, 'error', `Polling event error: ${rawMsg}`);
      if (isRateLimitError(rawMsg)) {
        triggerBanner('⚡ AI rate limit reached — the model is temporarily busy. This usually resolves in a minute. Your files are safe, no action needed.');
      } else {
        const { message, technicalDetails } = parseErrorDetails(rawMsg);
        triggerAlert('error', 'Captioning Polling Failure', message, technicalDetails);
      }
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
      const rawMsg = err.message || String(err);
      if (isRateLimitError(rawMsg)) {
        triggerBanner('⚡ AI rate limit reached — please wait a moment before regenerating captions.');
      } else {
        const { message, technicalDetails } = parseErrorDetails(rawMsg);
        triggerAlert('error', 'Caption Regeneration Failed', message, technicalDetails);
      }
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

      const enabledOutcomes: Array<{ name: string; ok: boolean; err?: string }> = [];
      if (config?.blueskyEnabled) {
        enabledOutcomes.push({
          name: 'Bluesky',
          ok: Boolean(bskyOutcome?.success),
          err: bskyOutcome?.error,
        });
      }
      if (config?.twitterEnabled) {
        enabledOutcomes.push({
          name: 'X/Twitter',
          ok: Boolean(twitterOutcome?.success),
          err: twitterOutcome?.error,
        });
      }

      if (enabledOutcomes.length === 0) {
        await createSystemLog(user.uid, 'error', 'Publish skipped — neither Bluesky nor X/Twitter is enabled in Configure Integrations.');
        triggerAlert('warning', 'No Platforms Enabled', 'Enable Bluesky and/or X/Twitter under Configure Integrations before publishing.');
        return;
      }

      const logMsg =
        'Publish Result:\n' +
        enabledOutcomes
          .map((o) => `${o.name}: ${o.ok ? '✅ Success' : `❌ Error: ${o.err || 'Unknown error'}`}`)
          .join('\n');

      const anySucceeded = enabledOutcomes.some((o) => o.ok);
      const anyFailed = enabledOutcomes.some((o) => !o.ok);

      await createSystemLog(user.uid, anyFailed && !anySucceeded ? 'error' : 'success', logMsg);

      if (!anySucceeded) {
        triggerAlert('error', 'Publishing Failed', logMsg);
        return;
      }

      // Now move file inside Drive under "posted" folder (uses service account fallback if browser token expired)
      if (activePost.driveFileId) {
        const activeToken = await getFreshDriveToken();
        await createSystemLog(user.uid, 'info', `Moving Google Drive file ${activePost.driveFileId} to 'posted' subfolder...`);
        const moveRes = await fetch(getApiUrl('/api/drive/move-file'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: activePost.driveFileId,
            parentFolderId: config?.driveFolderId,
            destinationFolderName: 'posted',
            gdriveToken: activeToken || 'SERVICE_ACCOUNT',
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
        await setDoc(doc(db, `users/${user.uid}`), updatedConfig, { merge: true });
        setConfig(updatedConfig);
        await createSystemLog(user.uid, 'info', `Rescheduled next automated polling loop for: ${new Date(nextTime).toLocaleTimeString()}`);
      }

      if (anyFailed) {
        triggerAlert('warning', 'Published with Errors', logMsg);
      } else {
        triggerAlert('success', 'Asset Published', 'Your chosen caption has been published to your enabled social channels.');
      }

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
        await createSystemLog(user.uid, 'info', `Archiving Google Drive file to 'skipped' subfolder...`);
        await fetch(getApiUrl('/api/drive/move-file'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: activePost.driveFileId,
            parentFolderId: config?.driveFolderId,
            destinationFolderName: 'skipped',
            gdriveToken: activeToken || 'SERVICE_ACCOUNT',
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
        await setDoc(doc(db, `users/${user.uid}`), updatedConfig, { merge: true });
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
      
      {/* Top Navigation Header */}
      <header className="sticky top-0 z-40 glass-premium border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src="/icon-192.png" alt="SCM" className="w-7 h-7 rounded-lg shrink-0" />
            <h1 className="font-semibold text-zinc-100 tracking-tight text-sm sm:text-base truncate">
              StoneContentManager
            </h1>
          </div>

          {user && (
            <>
              {/* Desktop navigation */}
              <nav className="hidden md:flex items-center bg-white/[0.04] border border-white/10 p-0.5 rounded-xl">
                <button
                  onClick={() => setActiveTab('dashboard')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'dashboard' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" /> Review
                </button>
                <button
                  onClick={() => setActiveTab('config')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'config' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Settings className="w-3.5 h-3.5" /> Settings
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'logs' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Terminal className="w-3.5 h-3.5" /> Logs
                </button>
              </nav>

              <div className="flex items-center gap-2 shrink-0">
                <span className="hidden sm:inline text-xs text-zinc-400 truncate max-w-[180px]">
                  {user.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="p-2 text-zinc-400 hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors cursor-pointer"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {/* Mobile navigation */}
        {user && (
          <div className="md:hidden border-t border-white/5 px-4 py-1.5 flex gap-1 bg-black/30">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                activeTab === 'dashboard' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" /> Review
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                activeTab === 'config' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400'
              }`}
            >
              <Settings className="w-3.5 h-3.5" /> Settings
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                activeTab === 'logs' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" /> Logs
            </button>
          </div>
        )}
      </header>

      {hostingDiagnosticWarning && (
        <div className="bg-amber-950/50 border-b border-amber-500/20 px-4 py-2.5 text-xs text-amber-200">
          <div className="max-w-6xl mx-auto flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="leading-snug">{hostingDiagnosticWarning}</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3">
          <RotateCw className="w-6 h-6 text-zinc-400 animate-spin" />
          <p className="text-xs text-zinc-400">Loading workspace...</p>
        </div>
      ) : !user ? (

        /* Sign-in Screen */
        <main className="flex-1 max-w-md mx-auto w-full flex flex-col justify-center px-4 py-16">
          <div className="bg-surface-dark border border-white/10 rounded-2xl p-8 text-center space-y-6">
            <img src="/icon-192.png" alt="StoneContentManager" className="w-12 h-12 rounded-xl mx-auto" />

            <div className="space-y-2">
              <h2 className="font-semibold text-zinc-100 text-xl tracking-tight">StoneContentManager</h2>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Draft captions from Google Drive photos with Gemini and publish to Bluesky and X.
              </p>
            </div>

            <button
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-3 bg-white hover:bg-zinc-100 text-zinc-900 rounded-xl py-3 px-4 text-sm font-semibold transition cursor-pointer"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Sign in with Google
            </button>
          </div>
        </main>
      ) : (

        /* Authenticated Workspace */
        <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 space-y-5">

          {/* First-time setup callout */}
          {isFirstTimeLogin && (
            <div className="bg-surface-dark border border-amber-500/30 p-4 rounded-2xl flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-100">Finish connecting your accounts</p>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Add your Bluesky or X credentials and Drive folder in Settings to start publishing.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('config')}
                className="px-4 py-2 btn-gold text-xs rounded-xl shrink-0 cursor-pointer"
              >
                Open Settings
              </button>
            </div>
          )}

          {/* Chrome Push Prompt Banner */}
          {isWebPushSupported() && !isThisDeviceSubscribed && (config?.pushNotificationsEnabled ?? true) && (
            <div className="bg-surface-dark border border-white/10 px-4 py-3 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-xs">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-medium text-zinc-100">Enable Chrome notifications on this device</p>
                  <p className="text-zinc-400">Get alerted when a scheduled draft is ready to review.</p>
                </div>
              </div>
              <button
                onClick={handleEnablePush}
                disabled={isPushBusy}
                className="px-3.5 py-2 btn-gold text-xs rounded-xl shrink-0 cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                <Bell className="w-3.5 h-3.5" />
                {isPushBusy ? 'Enabling...' : 'Enable Notifications'}
              </button>
            </div>
          )}

          {/* Review Workspace */}
          {activeTab === 'dashboard' && (
            <div className="space-y-5">

              {/* Compact Status Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-dark border border-white/10 rounded-2xl px-4 py-3 text-xs">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-zinc-400">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${config?.isPollingActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                    <span>
                      {config?.isPollingActive ? 'Next poll:' : 'Scheduler:'}{' '}
                      <strong className="text-zinc-100 font-mono font-medium">{countdownStr}</strong>
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span>Targets:</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${config?.blueskyEnabled ? 'bg-sky-500/15 text-sky-300' : 'bg-white/5 text-zinc-500'}`}>
                      Bluesky
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${config?.twitterEnabled ? 'bg-white/15 text-zinc-100' : 'bg-white/5 text-zinc-500'}`}>
                      X
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Bell className={`w-3.5 h-3.5 ${isThisDeviceSubscribed ? 'text-emerald-400' : 'text-zinc-500'}`} />
                    <span>{subscribedDeviceCount} device{subscribedDeviceCount === 1 ? '' : 's'}</span>
                  </div>
                </div>

                <button
                  onClick={handlePollAndPickRandom}
                  disabled={isPolling || isProcessing}
                  className="px-3 py-1.5 btn-gold-outline text-xs rounded-lg disabled:opacity-50 cursor-pointer flex items-center gap-1.5 ml-auto"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${isPolling ? 'animate-spin' : ''}`} />
                  {isPolling ? 'Scanning...' : 'Poll Drive Now'}
                </button>
              </div>

              {/* Draft Review Panel */}
              {activePost ? (
                <div className="bg-surface-dark border border-white/12 rounded-2xl overflow-hidden" id="phone-simulator">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                      <span className="text-xs font-semibold text-zinc-100">Ready to Review</span>
                      <span className="text-xs text-zinc-500 truncate hidden sm:inline">
                        {activePost.fileName}
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        dismissedPostIdRef.current = activePost.id;
                        setActivePost(null);
                      }}
                      className="text-xs text-zinc-500 hover:text-zinc-200 transition cursor-pointer p-1 rounded-md hover:bg-white/5"
                      aria-label="Dismiss draft"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2">
                    {/* Media Preview */}
                    <div className="relative bg-black flex items-center justify-center min-h-[260px] md:min-h-[420px] border-b md:border-b-0 md:border-r border-white/10">
                      <img
                        src={activePost.imageUrl}
                        alt={activePost.fileName}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-contain max-h-[460px]"
                      />
                      {activePost.mimeType?.startsWith('image/') && (
                        <button
                          onClick={() => setIsCropping(true)}
                          className="absolute bottom-3 right-3 px-3 py-1.5 bg-black/75 hover:bg-black/90 backdrop-blur-sm border border-white/15 text-zinc-100 text-xs font-medium rounded-lg flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <Crop className="w-3.5 h-3.5" /> Crop
                        </button>
                      )}
                    </div>

                    {/* Caption Picker & Editor */}
                    <div className="p-5 flex flex-col justify-between gap-4">
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-zinc-400">Pick a caption</span>
                            <button
                              onClick={handleRegenerateCaptions}
                              disabled={isRegenerating}
                              className="text-xs text-zinc-400 hover:text-zinc-100 font-medium transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                            >
                              <RotateCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
                              {isRegenerating ? 'Regenerating...' : 'Regenerate'}
                            </button>
                          </div>

                          <div className="space-y-2">
                            {activePost.captions.map((cap, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => {
                                  setSelectedIdx(i);
                                  setEditedCaption(cap);
                                  handleSelectCaption(cap);
                                }}
                                className={`w-full text-left p-3 rounded-xl border transition flex items-start gap-3 cursor-pointer ${
                                  selectedIdx === i
                                    ? 'bg-white/[0.07] border-white/25 text-zinc-100'
                                    : 'bg-black/25 border-white/8 text-zinc-300 hover:border-white/20'
                                }`}
                              >
                                <span
                                  className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition ${
                                    selectedIdx === i
                                      ? 'bg-zinc-100 border-zinc-100 text-zinc-950'
                                      : 'border-zinc-600'
                                  }`}
                                >
                                  {selectedIdx === i && <Check className="w-2.5 h-2.5" />}
                                </span>
                                <span className="text-xs leading-relaxed">{cap}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <label className="font-medium text-zinc-400">Edit caption</label>
                            <span className={`font-mono text-[11px] ${editedCaption.length > 280 ? 'text-amber-400' : 'text-zinc-500'}`}>
                              {editedCaption.length} / 300
                            </span>
                          </div>
                          <textarea
                            value={editedCaption}
                            onChange={(e) => {
                              setEditedCaption(e.target.value);
                              handleSelectCaption(e.target.value);
                            }}
                            rows={3}
                            className="w-full bg-black/40 border border-white/10 focus:border-white/30 text-zinc-100 text-sm rounded-xl px-3.5 py-2.5 outline-none resize-none transition placeholder:text-zinc-600 leading-relaxed"
                            placeholder="Write or refine your caption..."
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5 pt-2">
                        <button
                          onClick={handleSkipProposal}
                          className="px-4 py-2.5 bg-white/[0.04] border border-white/10 hover:bg-red-500/10 hover:border-red-500/30 text-zinc-300 hover:text-red-300 text-xs font-medium rounded-xl transition cursor-pointer"
                        >
                          Skip
                        </button>
                        <button
                          onClick={() => handlePublishContent(editedCaption)}
                          disabled={isPublishing}
                          className="flex-1 py-2.5 btn-gold text-xs rounded-xl flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                        >
                          <Share2 className="w-3.5 h-3.5" />
                          {isPublishing
                            ? 'Publishing...'
                            : config?.blueskyEnabled && config?.twitterEnabled
                              ? 'Publish to Bluesky & X'
                              : config?.blueskyEnabled
                                ? 'Publish to Bluesky'
                                : config?.twitterEnabled
                                  ? 'Publish to X'
                                  : 'Publish Now'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-surface-dark border border-white/10 rounded-2xl p-5 flex items-center gap-3.5">
                  <div className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 text-zinc-400 flex items-center justify-center shrink-0">
                    <Eye className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200">No draft waiting</p>
                    <p className="text-xs text-zinc-500">
                      Click <strong className="text-zinc-300">Poll Drive Now</strong> above, upload a file below, or wait for the next scheduled check.
                    </p>
                  </div>
                </div>
              )}

              {/* Upload & Recent Posts */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                <div className="lg:col-span-6">
                  <ManualUploadCard onUpload={handleManualUploadFlow} isProcessing={isProcessing} />
                </div>

                <div className="lg:col-span-6">
                  <div className="bg-surface-dark border border-white/10 rounded-2xl p-5 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-zinc-100">Recent Posts</h3>
                      <span className="text-xs font-mono text-zinc-500">{posts.length}</span>
                    </div>

                    {posts.length === 0 ? (
                      <div className="py-10 text-center text-zinc-500 text-xs">
                        No posts processed yet.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1 no-scrollbar">
                        {posts.map((post) => (
                          <div
                            key={post.id}
                            className={`flex items-start gap-3 p-2.5 border rounded-xl transition ${
                              post.status === 'pending_review' ? 'cursor-pointer' : ''
                            } ${
                              activePost?.id === post.id
                                ? 'bg-white/[0.06] border-white/25'
                                : 'bg-black/25 border-white/5 hover:border-white/15'
                            }`}
                            onClick={() => post.status === 'pending_review' ? setActivePost(post) : undefined}
                          >
                            <img
                              src={post.imageUrl}
                              alt={post.fileName}
                              referrerPolicy="no-referrer"
                              className="w-11 h-11 rounded-lg object-cover bg-zinc-900 shrink-0 border border-white/10"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <h4 className="text-xs font-medium text-zinc-200 truncate">{post.fileName}</h4>
                                {post.status === 'posted' ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 shrink-0">
                                    Posted
                                  </span>
                                ) : post.status === 'skipped' ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-400 shrink-0">
                                    Skipped
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-300 shrink-0">
                                    Review
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                                {post.selectedCaption || 'No caption'}
                              </p>
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
            <div className="bg-surface-dark border border-white/10 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-100">Activity Logs</h3>
                <button
                  onClick={() => handleSessionLoad(user)}
                  className="px-3 py-1.5 btn-gold-outline text-xs rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCw className="w-3.5 h-3.5" /> Refresh
                </button>
              </div>

              <div className="bg-black/60 border border-white/10 rounded-xl p-4 font-mono text-xs text-zinc-300 space-y-1.5 h-[460px] overflow-y-auto no-scrollbar">
                {logs.length === 0 ? (
                  <span className="text-zinc-500">No activity logged yet.</span>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="flex gap-2.5 py-1 border-b border-white/5 leading-relaxed">
                      <span className="text-zinc-500 shrink-0 select-none">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      {log.type === 'success' && <span className="text-emerald-400 shrink-0 font-semibold">OK</span>}
                      {log.type === 'error' && <span className="text-red-400 shrink-0 font-semibold">ERR</span>}
                      {log.type === 'info' && <span className="text-amber-400 shrink-0 font-semibold">INFO</span>}
                      <span className="text-zinc-200 flex-1 whitespace-pre-wrap">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'config' && config && (
            <ConfigManager
              config={config}
              onSave={handleSaveConfig}
              isLoading={isSavingConfig}
              serviceAccountEmail={serviceAccountEmail}
              isThisDeviceSubscribed={isThisDeviceSubscribed}
              subscribedDeviceCount={subscribedDeviceCount}
              isPushBusy={isPushBusy}
              onEnablePush={handleEnablePush}
              onDisablePush={handleDisablePush}
              onTestPush={handleTestPush}
            />
          )}

        </main>
      )}

      {/* Footer */}
      <footer className="border-t border-white/5 py-4 text-xs text-zinc-500 mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-2">
          <span>StoneContentManager</span>
          <span className="font-mono text-[11px]">
            v{versionInfo.version} · {versionInfo.sha}
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

      {/* Non-blocking Top Banner */}
      {notifBanner && (
        <div
          role="alert"
          aria-live="polite"
          className="fixed top-0 left-0 right-0 z-[60] flex items-center gap-3 px-4 py-3 bg-zinc-900/95 border-b border-white/15 backdrop-blur-md shadow-xl animate-slide-down"
        >
          <Zap className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="flex-1 text-xs font-medium text-zinc-100 leading-relaxed">
            {notifBanner.message}
            {notifBanner.retryAt && (
              <span className="ml-2 text-amber-400 font-semibold">Retry at: {notifBanner.retryAt}</span>
            )}
          </p>
          <button
            onClick={dismissBanner}
            aria-label="Dismiss notification"
            className="p-1 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Alert Modal */}
      {customAlert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm focus:outline-none"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCustomAlert(null);
          }}
        >
          <div className="w-full max-w-lg bg-surface-dark border border-white/15 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
            <div className="px-5 py-4 flex items-center justify-between border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2.5">
                {customAlert.type === 'error' && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                {customAlert.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                {customAlert.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />}
                {customAlert.type === 'info' && <Shield className="w-4 h-4 text-zinc-300 shrink-0" />}
                <h3 className="font-semibold text-sm text-zinc-100">{customAlert.title}</h3>
              </div>
              <button
                onClick={() => setCustomAlert(null)}
                className="p-1 text-zinc-400 hover:text-zinc-100 rounded-md hover:bg-white/5 transition cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {customAlert.message}
              </div>

              {customAlert.technicalDetails && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>Details</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(customAlert.technicalDetails || '');
                      }}
                      className="text-xs text-zinc-300 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                  <div className="w-full max-h-44 overflow-auto rounded-xl bg-black/60 border border-white/10 p-3 font-mono text-[11px] leading-relaxed text-red-300 whitespace-pre-wrap">
                    {customAlert.technicalDetails}
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-white/10 flex items-center justify-end gap-2 shrink-0">
              {customAlert.technicalDetails && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `Title: ${customAlert.title}\nMessage: ${customAlert.message}\nDetails: ${customAlert.technicalDetails}`
                    );
                  }}
                  className="px-3.5 py-2 btn-gold-outline text-xs rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy Log
                </button>
              )}
              <button
                onClick={() => setCustomAlert(null)}
                className="px-4 py-2 btn-gold text-xs rounded-lg cursor-pointer"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
