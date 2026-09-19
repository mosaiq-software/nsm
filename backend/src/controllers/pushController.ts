import webpush from 'web-push';
import { Capability, DeploymentState, Project, PushSubscriptionJSON, TeamType } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { getUserByAuthTokenModel, getUserByGithubIdModel, getUserByLoginModel } from '@/persistence/userPersistence';
import { createPushSubscriptionModel, deleteAllPushSubscriptionsModel, deletePushSubscriptionByEndpointModel, getAllPushSubscriptionsModel, StoredPushSubscription } from '@/persistence/pushSubscriptionPersistence';
import { getMutingGithubIdsForProjectModel, muteProjectModel, unmuteProjectModel, isProjectMutedModel } from '@/persistence/notificationMutePersistence';
import { getEffectiveCapabilitiesForProject, listOrgMembersForTeam, resolveTeamForProject } from '@/controllers/authz';
import { getAllAdminsModel } from '@/persistence/adminPersistence';
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

// Deliver an already-rendered payload to every push subscription owned by the given set of users.
// Subscriptions are grouped per user; a user who has muted the project (when projectIdForMute is
// given) is skipped entirely. Stale subscriptions (404/410 from the push service) are pruned as we
// discover them. Returns delivery counts for the caller to log. Leader-only concerns (access checks,
// eligibility) are the caller's responsibility.
export const sendPushToGithubIds = async (
    githubIds: Iterable<string>,
    payload: string,
    opts?: { projectIdForMute?: string }
): Promise<{ userCount: number; targetCount: number; sentCount: number; prunedCount: number; mutedCount: number }> => {
    await ensureVapidKeys();
    if (!vapidKeys) return { userCount: 0, targetCount: 0, sentCount: 0, prunedCount: 0, mutedCount: 0 };

    const idSet = new Set<string>(githubIds);
    if (idSet.size === 0) return { userCount: 0, targetCount: 0, sentCount: 0, prunedCount: 0, mutedCount: 0 };

    const subs = await getAllPushSubscriptionsModel();

    // Group subscriptions by owning user so each recipient's mute preference is resolved once, not
    // per browser/endpoint. Only keep subscriptions belonging to a requested recipient.
    const byUser = new Map<string, StoredPushSubscription[]>();
    for (const sub of subs) {
        if (!idSet.has(sub.githubId)) continue;
        const list = byUser.get(sub.githubId) ?? [];
        list.push(sub);
        byUser.set(sub.githubId, list);
    }

    const muted = opts?.projectIdForMute ? await getMutingGithubIdsForProjectModel(opts.projectIdForMute) : new Set<string>();

    let mutedCount = 0;
    const targets = [...byUser.entries()].flatMap(([githubId, list]) => {
        if (muted.has(githubId)) {
            mutedCount++;
            return [] as StoredPushSubscription[];
        }
        return list;
    });

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
    return { userCount: byUser.size, targetCount: targets.length, sentCount, prunedCount, mutedCount };
};

// Push a deployment notification to every opted-in browser. Leader-only (all deploy state lives on
// the leader). Callers fire-and-forget this, so it must never reject: all failures are swallowed and
// logged.
export const sendDeploymentNotification = async (project: Project, state: DeploymentState): Promise<void> => {
    try {
        if (!cluster.isLeader()) return;

        const copy = copyForState(project, state);
        if (!copy) return;

        const payload = JSON.stringify({
            title: copy.title,
            body: copy.body,
            url: `/p/${project.id}/deploy`,
            tag: `nsm-deploy-${project.id}`,
        });

        // Only notify subscribers who still hold VIEW on the project (a removed team member drops
        // out here). Muting is applied inside sendPushToGithubIds.
        const subs = await getAllPushSubscriptionsModel();
        const distinctIds = [...new Set(subs.map((s) => s.githubId))];
        const eligibleGithubIds: string[] = [];
        await Promise.all(
            distinctIds.map(async (githubId) => {
                const user = await getUserByGithubIdModel(githubId);
                if (!user) return;
                const caps = await getEffectiveCapabilitiesForProject(user, { repoOwner: project.repoOwner });
                if (caps.includes(Capability.VIEW)) eligibleGithubIds.push(githubId);
            })
        );

        const res = await sendPushToGithubIds(eligibleGithubIds, payload, { projectIdForMute: project.id });
        pushLog.info(
            { action: 'notification_dispatched', projectId: project.id, state, eligibleUserCount: eligibleGithubIds.length, mutedCount: res.mutedCount, subscriberCount: res.targetCount, sentCount: res.sentCount, prunedCount: res.prunedCount },
            `dispatched ${state} notification for ${project.id} to ${res.sentCount}/${res.targetCount} subscriber(s)`
        );
    } catch (e: any) {
        pushLog.error({ action: 'notification_dispatch_failed', projectId: project.id, state, err: e?.message || String(e) }, 'failed to send deployment notification');
    }
};

// A single resource that a project has exceeded its allocation on, with the measured usage and the
// configured limit (canonical units: cores for cpu, bytes for memory/storage).
export interface QuotaBreachInfo {
    resource: 'cpu' | 'memory' | 'storage';
    usage: number;
    limit: number;
}

const formatGiB = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const quotaBreachLine = (b: QuotaBreachInfo): string => {
    switch (b.resource) {
        case 'cpu':
            return `CPU: ${b.usage.toFixed(2)} / ${b.limit.toFixed(2)} cores`;
        case 'memory':
            return `Memory: ${formatGiB(b.usage)} / ${formatGiB(b.limit)}`;
        case 'storage':
            return `Storage: ${formatGiB(b.usage)} / ${formatGiB(b.limit)}`;
    }
};

// The union of NSM admins (stored admins + the implicit super admin) and the members of the
// project's owning team, as stable githubIds. Recipients who have never signed in (no user row)
// simply resolve to nothing and are skipped downstream.
const resolveQuotaRecipientGithubIds = async (project: Project): Promise<Set<string>> => {
    const ids = new Set<string>();

    const admins = await getAllAdminsModel();
    for (const a of admins) ids.add(a.id);

    const superLogin = process.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
    if (superLogin) {
        const su = await getUserByLoginModel(superLogin);
        if (su) ids.add(su.githubId);
    }

    const team = await resolveTeamForProject(project);
    if (team.type === TeamType.USER) {
        // A USER-type team is a single GitHub user whose login is the repo owner.
        const owner = await getUserByLoginModel(team.login);
        if (owner) ids.add(owner.githubId);
    } else {
        const members = await listOrgMembersForTeam(team.login);
        for (const m of members) ids.add(m.id);
    }

    return ids;
};

// Push a resource-allocation breach notification to all NSM admins and the project's team members.
// Leader-only; fire-and-forget (never rejects). Respects each recipient's per-project mute.
export const sendQuotaBreachNotification = async (project: Project, breached: QuotaBreachInfo[]): Promise<void> => {
    try {
        if (!cluster.isLeader()) return;
        if (!breached.length) return;

        const payload = JSON.stringify({
            title: `Over allocation: ${project.id}`,
            body: breached.map(quotaBreachLine).join('\n'),
            url: `/p/${project.id}/logs`,
            tag: `nsm-quota-${project.id}`,
        });

        const recipients = await resolveQuotaRecipientGithubIds(project);
        const res = await sendPushToGithubIds(recipients, payload, { projectIdForMute: project.id });
        pushLog.info(
            { action: 'quota_notification_dispatched', projectId: project.id, resources: breached.map((b) => b.resource), recipientCount: recipients.size, mutedCount: res.mutedCount, subscriberCount: res.targetCount, sentCount: res.sentCount, prunedCount: res.prunedCount },
            `dispatched quota breach notification for ${project.id} to ${res.sentCount}/${res.targetCount} subscriber(s)`
        );
    } catch (e: any) {
        pushLog.error({ action: 'quota_notification_dispatch_failed', projectId: project.id, err: e?.message || String(e) }, 'failed to send quota breach notification');
    }
};
