import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { rawApiGetNoHook, rawApiPostNoHook } from '@/utils/api';

// Web Push is only available in secure contexts (HTTPS, or localhost for dev) with SW + PushManager.
export const isPushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// The VAPID public key arrives as a base64url string; PushManager needs it as a Uint8Array.
const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
};

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | undefined> => {
    if (!('serviceWorker' in navigator)) return undefined;
    try {
        return await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
        console.error('Failed to register service worker', e);
        return undefined;
    }
};

// True when this browser already has an active push subscription.
export const isPushSubscribed = async (): Promise<boolean> => {
    if (!isPushSupported()) return false;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        return Boolean(sub);
    } catch {
        return false;
    }
};

// Request permission, create a push subscription, and register it with the leader. Returns true on
// success. Throws with a user-facing message on permission denial or missing server config.
export const enablePush = async (token: string): Promise<boolean> => {
    if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser');

    await registerServiceWorker();
    const reg = await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted');

    const vapidPublicKey = await rawApiGetNoHook(API_ROUTES.GET_VAPID_PUBLIC_KEY, {}, token);
    if (!vapidPublicKey) throw new Error('Push notifications are not configured on the server');

    const existing = await reg.pushManager.getSubscription();
    const sub =
        existing ??
        (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));

    await rawApiPostNoHook(API_ROUTES.POST_PUSH_SUBSCRIBE, {}, sub.toJSON() as any, token);
    return true;
};

// Remove the subscription both server-side and in the browser.
export const disablePush = async (token: string): Promise<void> => {
    if (!isPushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await rawApiPostNoHook(API_ROUTES.POST_PUSH_UNSUBSCRIBE, {}, { endpoint: sub.endpoint }, token);
    await sub.unsubscribe().catch(() => {});
};
