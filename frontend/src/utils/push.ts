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

// Read whether the signed-in user currently receives notifications for a project. This is the
// server-side per-user preference (opt-out); it does not account for whether this browser has an
// active push subscription.
export const getProjectNotificationEnabled = async (token: string, projectId: string): Promise<boolean> => {
    const result = await rawApiGetNoHook(API_ROUTES.GET_PROJECT_NOTIFICATION, { projectId }, token);
    return Boolean(result?.enabled);
};

// Set the per-user notification preference for a project. When enabling, first ensure this browser
// has a push subscription (requesting permission if needed) so notifications can actually arrive.
export const setProjectNotificationEnabled = async (token: string, projectId: string, enabled: boolean): Promise<void> => {
    if (enabled && !(await isPushSubscribed())) {
        await enablePush(token);
    }
    await rawApiPostNoHook(API_ROUTES.POST_SET_PROJECT_NOTIFICATION, { projectId }, { enabled }, token);
};

// Regenerate the server-side VAPID key pair. This invalidates every existing subscription (all
// browsers must re-subscribe), so if this browser was subscribed we drop the now-stale local
// subscription and re-subscribe against the new key. Returns the server result.
export const regeneratePushKeys = async (token: string): Promise<{ ok: boolean; reason?: string }> => {
    const result = await rawApiPostNoHook(API_ROUTES.POST_REGENERATE_VAPID, {}, {}, token);
    if (!result || !result.ok) {
        return { ok: false, reason: result?.reason || 'Failed to regenerate push keys' };
    }

    if (isPushSupported()) {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
            // The old subscription can no longer receive pushes; replace it with a fresh one.
            await existing.unsubscribe().catch(() => {});
            await enablePush(token).catch(() => {});
        }
    }
    return { ok: true };
};
