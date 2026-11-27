export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArraysEqual(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const view = new Uint8Array(a);
  if (view.length !== b.length) return false;
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== b[i]) return false;
  }
  return true;
}

function getDeviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android Chrome';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS Browser';
  if (/Mac/i.test(ua)) return 'macOS Chrome';
  if (/Windows/i.test(ua)) return 'Windows Chrome';
  if (/Linux/i.test(ua)) return 'Linux Chrome';
  return 'Web Browser';
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  await reg.update().catch(() => {});
  return navigator.serviceWorker.ready;
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  const reg = await registerPushServiceWorker();
  return reg.pushManager.getSubscription();
}

export async function subscribeToWebPush(
  getApiUrl: (path: string) => string,
  idToken: string
): Promise<{ subscription: PushSubscription; deviceLabel: string }> {
  if (!isWebPushSupported()) {
    throw new Error('Web Push notifications are not supported in this browser.');
  }

  let permission: NotificationPermission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Browser returned notification permission "denied". If Chrome Site Settings already shows Allowed: (1) reload this tab, (2) open in a normal Chrome tab (not Incognito or an embedded/in-app browser), and (3) check OS notification settings for Chrome (Android Settings → Apps → Chrome → Notifications, or macOS System Settings → Notifications → Google Chrome).'
        : 'Notification permission prompt was dismissed. Tap Enable Notifications again and choose Allow.'
    );
  }

  const keyRes = await fetch(getApiUrl('/api/push/vapid-public-key'));
  if (!keyRes.ok) {
    throw new Error(`Failed to load Web Push key (${keyRes.status})`);
  }
  const { publicKey } = await keyRes.json();
  if (!publicKey) {
    throw new Error('Server returned an empty VAPID public key.');
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  const reg = await registerPushServiceWorker();
  let subscription = await reg.pushManager.getSubscription();

  // If the browser holds a subscription for an older VAPID key, rotate it cleanly.
  if (subscription && !uint8ArraysEqual(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }

  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (subErr: any) {
      throw new Error(
        `Browser push subscription failed (${subErr?.message || subErr}). Make sure you are in a normal Chrome window (not Incognito or an embedded browser) and Chrome notifications are enabled in OS settings.`
      );
    }
  }

  const deviceLabel = getDeviceLabel();
  const saveRes = await fetch(getApiUrl('/api/push/subscribe'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      deviceLabel,
    }),
  });

  if (!saveRes.ok) {
    const errBody = await saveRes.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to save push subscription (${saveRes.status})`);
  }

  return { subscription, deviceLabel };
}

export async function unsubscribeFromWebPush(
  getApiUrl: (path: string) => string,
  idToken: string
): Promise<void> {
  if (!isWebPushSupported()) return;
  const reg = await registerPushServiceWorker();
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;

  await fetch(getApiUrl('/api/push/unsubscribe'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});

  await subscription.unsubscribe();
}

export async function sendTestWebPush(
  getApiUrl: (path: string) => string,
  idToken: string
): Promise<{ sent: number; failed: number; cleanedUp: number }> {
  const res = await fetch(getApiUrl('/api/push/test'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Test notification failed (${res.status})`);
  }
  return data;
}
