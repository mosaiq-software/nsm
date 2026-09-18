import webpush from 'web-push';
import { Capability, DeploymentState, Project, PushSubscriptionJSON } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { getUserByAuthTokenModel, getUserByGithubIdModel } from '@/persistence/userPersistence';
import { createPushSubscriptionModel, deleteAllPushSubscriptionsModel, deletePushSubscriptionByEndpointModel, getAllPushSubscriptionsModel, StoredPushSubscription } from '@/persistence/pushSubscriptionPersistence';
import { getMutingGithubIdsForProjectModel, muteProjectModel, unmuteProjectModel, isProjectMutedModel } from '@/persistence/notificationMutePersistence';
import { getEffectiveCapabilitiesForProject } from '@/controllers/authz';
import { getMeta, setMeta } from '@/persistence/clusterMetaPersistence';
import { areaLog } from '@/utils/log';

const pushLog = areaLog('push');

// Subscription endpoints are long URLs; truncate for logs so they stay readable and low-cardinality.
const truncEndpoint = (endpoint: string): string => (endpoint.length > 40 ? `${endpoint.slice(0, 40)}...` : endpoint);

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
        pushLog.error({ action: 'vapid_apply_failed', err: e?.message || String(e) }, 'failed to apply VAPID details');
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
        pushLog.info({ action: 'vapid_loaded', source: 'env' }, 'VAPID keys loaded from environment');
        return;
    }

    const stored = await getMeta(VAPID_META_KEY);
    if (stored) {
        try {
            vapidKeys = JSON.parse(stored) as VapidKeys;
            applyVapidDetails();
            pushLog.info({ action: 'vapid_loaded', source: 'stored' }, 'VAPID keys loaded from cluster metadata');
            return;
        } catch {
            pushLog.warn({ action: 'vapid_unreadable' }, 'stored VAPID keys were unreadable; regenerating');
        }
    }

    vapidKeys = webpush.generateVAPIDKeys();
    await setMeta(VAPID_META_KEY, JSON.stringify(vapidKeys));
    applyVapidDetails();
    pushLog.info({ action: 'vapid_generated', source: 'generated' }, 'generated a new VAPID key pair');
};

export const initWebPush = async (): Promise<void> => {
    try {
        await ensureVapidKeys();
        pushLog.info({ action: 'webpush_initialized' }, 'web push initialized');
    } catch (e: any) {
        pushLog.error({ action: 'webpush_init_failed', err: e?.message || String(e) }, 'failed to initialize VAPID keys');
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
    pushLog.info({ action: 'vapid_regenerated', subscriptionsCleared: true }, 'regenerated VAPID key pair and cleared existing subscriptions');
    return { ok: true };
};

// Store a browser's push subscription against the signed-in user identified by their auth token.
export const subscribe = async (authToken: string, sub: PushSubscriptionJSON): Promise<boolean> => {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
    const user = await getUserByAuthTokenModel(authToken);
    if (!user) return false;
    await createPushSubscriptionModel(user.githubId, sub);
    pushLog.info({ action: 'subscription_added', githubId: user.githubId, endpoint: truncEndpoint(sub.endpoint) }, `push subscription added for ${user.name}`);
    return true;
};

export const unsubscribe = async (endpoint: string): Promise<void> => {
    if (!endpoint) return;
    await deletePushSubscriptionByEndpointModel(endpoint);
    pushLog.info({ action: 'subscription_removed', endpoint: truncEndpoint(endpoint) }, 'push subscription removed');
};

// Whether the user identified by authToken currently receives notifications for a project.
// Opt-out: enabled unless the user has explicitly muted the project.
export const getProjectNotificationEnabled = async (authToken: string, projectId: string): Promise<boolean> => {
    const user = await getUserByAuthTokenModel(authToken);
    if (!user) return false;
    return !(await isProjectMutedModel(user.githubId, projectId));
};

// Enable or mute a project's notifications for the user identified by authToken.
export const setProjectNotification = async (authToken: string, projectId: string, enabled: boolean): Promise<boolean> => {
    const user = await getUserByAuthTokenModel(authToken);
    if (!user) return false;
    if (enabled) {
        await unmuteProjectModel(user.githubId, projectId);
    } else {
        await muteProjectModel(user.githubId, projectId);
    }
    pushLog.info({ action: 'notification_preference_set', githubId: user.githubId, projectId, enabled }, `notifications ${enabled ? 'enabled' : 'muted'} for ${user.name} on ${projectId}`);
    return true;
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

        // Group subscriptions by owning user so each recipient's mute preference and current access
        // are resolved once, not per browser/endpoint.
        const byUser = new Map<string, StoredPushSubscription[]>();
        for (const sub of subs) {
            const list = byUser.get(sub.githubId) ?? [];
            list.push(sub);
            byUser.set(sub.githubId, list);
        }

        const muted = await getMutingGithubIdsForProjectModel(project.id);

        // Decide, per user, whether they should receive this notification: not muted, still known,
        // and still holding VIEW on the project (a removed team member drops out here).
        const eligibleGithubIds: string[] = [];
        let mutedCount = 0;
        let noAccessCount = 0;
        await Promise.all(
            [...byUser.keys()].map(async (githubId) => {
                if (muted.has(githubId)) {
                    mutedCount++;
                    return;
                }
                const user = await getUserByGithubIdModel(githubId);
                if (!user) {
                    noAccessCount++;
                    return;
                }
                const caps = await getEffectiveCapabilitiesForProject(user, { repoOwner: project.repoOwner });
                if (!caps.includes(Capability.VIEW)) {
                    noAccessCount++;
                    return;
                }
                eligibleGithubIds.push(githubId);
            })
        );

        const targets = eligibleGithubIds.flatMap((githubId) => byUser.get(githubId) ?? []);
        let sentCount = 0;
        let prunedCount = 0;
        await Promise.allSettled(
            targets.map(async (sub) => {
                try {
                    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
                    sentCount++;
                } catch (e: any) {
                    const status = e?.statusCode;
                    if (status === 404 || status === 410) {
                        await deletePushSubscriptionByEndpointModel(sub.endpoint).catch(() => {});
                        prunedCount++;
                        pushLog.debug({ action: 'subscription_pruned', endpoint: truncEndpoint(sub.endpoint), statusCode: status }, 'pruned stale push subscription');
                    } else {
                        pushLog.error({ action: 'notification_send_failed', endpoint: truncEndpoint(sub.endpoint), err: status || e?.message || String(e) }, 'failed to send notification');
                    }
                }
            })
        );
        pushLog.info(
            { action: 'notification_dispatched', projectId: project.id, state, userCount: byUser.size, eligibleUserCount: eligibleGithubIds.length, mutedCount, noAccessCount, subscriberCount: targets.length, sentCount, prunedCount },
            `dispatched ${state} notification for ${project.id} to ${sentCount}/${targets.length} subscriber(s)`
        );
    } catch (e: any) {
        pushLog.error({ action: 'notification_dispatch_failed', projectId: project.id, state, err: e?.message || String(e) }, 'failed to send deployment notification');
    }
};
