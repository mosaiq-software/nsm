import webpush from 'web-push';
import { DeploymentState, Project, PushSubscriptionJSON } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { createPushSubscriptionModel, deleteAllPushSubscriptionsModel, deletePushSubscriptionByEndpointModel, getAllPushSubscriptionsModel } from '@/persistence/pushSubscriptionPersistence';
import { getMeta, setMeta } from '@/persistence/clusterMetaPersistence';

// Cluster-metadata key under which the generated VAPID key pair is persisted on the leader.
const VAPID_META_KEY = 'vapidKeys';

interface VapidKeys {
    publicKey: string;
    privateKey: string;
}

// The effective key pair the leader signs push messages with, resolved once during init.
let vapidKeys: VapidKeys | null = null;

// True when the key pair is pinned via environment config. Env-pinned keys are authoritative and
// are never auto-generated over or regenerated.
const envKeysPinned = (): boolean => Boolean(config.vapidPublicKey && config.vapidPrivateKey);

const applyVapidDetails = (): void => {
    if (!vapidKeys) return;
    try {
        webpush.setVapidDetails(config.vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
    } catch (e: any) {
        console.error('[push] failed to apply VAPID details:', e?.message || e);
    }
};

// Resolve the VAPID key pair, in precedence order:
//   1. Explicit env config (NSM_VAPID_*) - authoritative, never overwritten.
//   2. A pair persisted in cluster metadata from a previous run.
//   3. A freshly generated pair, persisted for reuse.
// Leader-only (writes cluster metadata); a no-op once resolved.
export const ensureVapidKeys = async (): Promise<void> => {
    if (vapidKeys) return;

    if (envKeysPinned()) {
        vapidKeys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
        applyVapidDetails();
        return;
    }

    const stored = await getMeta(VAPID_META_KEY);
    if (stored) {
        try {
            vapidKeys = JSON.parse(stored) as VapidKeys;
            applyVapidDetails();
            return;
        } catch {
            console.error('[push] stored VAPID keys were unreadable; regenerating');
        }
    }

    vapidKeys = webpush.generateVAPIDKeys();
    await setMeta(VAPID_META_KEY, JSON.stringify(vapidKeys));
    applyVapidDetails();
    console.log('[push] generated a new VAPID key pair');
};

export const initWebPush = async (): Promise<void> => {
    try {
        await ensureVapidKeys();
    } catch (e: any) {
        console.error('[push] failed to initialize VAPID keys:', e?.message || e);
    }
};

export const getVapidPublicKey = (): string => vapidKeys?.publicKey ?? '';

// Generate and persist a brand-new VAPID key pair, then drop all existing subscriptions (they were
// created against the old key and can no longer receive pushes; browsers must re-subscribe).
// Refused when keys are pinned via environment config.
export const regenerateVapidKeys = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (envKeysPinned()) {
        return { ok: false, reason: 'VAPID keys are pinned via environment configuration and cannot be regenerated.' };
    }
    vapidKeys = webpush.generateVAPIDKeys();
    await setMeta(VAPID_META_KEY, JSON.stringify(vapidKeys));
    applyVapidDetails();
    await deleteAllPushSubscriptionsModel();
    console.log('[push] regenerated VAPID key pair and cleared existing subscriptions');
    return { ok: true };
};

// Store a browser's push subscription against the signed-in user identified by their auth token.
export const subscribe = async (authToken: string, sub: PushSubscriptionJSON): Promise<boolean> => {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
    const user = await getUserByAuthTokenModel(authToken);
    if (!user) return false;
    await createPushSubscriptionModel(user.githubId, sub);
    return true;
};

export const unsubscribe = async (endpoint: string): Promise<void> => {
    if (!endpoint) return;
    await deletePushSubscriptionByEndpointModel(endpoint);
};

interface NotificationCopy {
    title: string;
    body: string;
}

// Human-readable copy per deployment state. Returns null for states we don't notify on.
const copyForState = (project: Project, state: DeploymentState): NotificationCopy | null => {
    switch (state) {
        case DeploymentState.QUEUED:
            return { title: `Deploy started: ${project.id}`, body: `${project.id} was queued for deployment.` };
        case DeploymentState.DEPLOYED:
            return { title: `Deployed: ${project.id}`, body: `${project.id} finished deploying.` };
        case DeploymentState.HEALTHY:
            return { title: `Healthy: ${project.id}`, body: `${project.id} is deployed and healthy.` };
        case DeploymentState.FAILED:
            return { title: `Deploy failed: ${project.id}`, body: `${project.id} failed to deploy.` };
        default:
            return null;
    }
};

// Push a deployment notification to every opted-in browser. Leader-only (all deploy state lives on
// the leader). Stale subscriptions (404/410 from the push service) are pruned as we discover them.
// Callers fire-and-forget this, so it must never reject: all failures are swallowed and logged.
export const sendDeploymentNotification = async (project: Project, state: DeploymentState): Promise<void> => {
    try {
        if (!cluster.isLeader()) return;

        const copy = copyForState(project, state);
        if (!copy) return;

        await ensureVapidKeys();
        if (!vapidKeys) return;

        const payload = JSON.stringify({
            title: copy.title,
            body: copy.body,
            url: `/p/${project.id}/deploy`,
            tag: `nsm-deploy-${project.id}`,
        });

        const subs = await getAllPushSubscriptionsModel();
        await Promise.allSettled(
            subs.map(async (sub) => {
                try {
                    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
                } catch (e: any) {
                    const status = e?.statusCode;
                    if (status === 404 || status === 410) {
                        await deletePushSubscriptionByEndpointModel(sub.endpoint).catch(() => {});
                    } else {
                        console.error('[push] failed to send notification:', status || e?.message || e);
                    }
                }
            })
        );
    } catch (e: any) {
        console.error('[push] failed to send deployment notification:', e?.message || e);
    }
};
