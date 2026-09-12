import webpush from 'web-push';
import { DeploymentState, Project, PushSubscriptionJSON } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { createPushSubscriptionModel, deletePushSubscriptionByEndpointModel, getAllPushSubscriptionsModel } from '@/persistence/pushSubscriptionPersistence';

// Web Push is optional: without a VAPID key pair the daemon simply skips all push work.
export const isPushConfigured = (): boolean => Boolean(config.vapidPublicKey && config.vapidPrivateKey);

let initialized = false;
export const initWebPush = (): void => {
    if (initialized || !isPushConfigured()) return;
    try {
        webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
        initialized = true;
    } catch (e: any) {
        console.error('[push] failed to initialize VAPID details:', e?.message || e);
    }
};

export const getVapidPublicKey = (): string => config.vapidPublicKey;

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
// the leader) and a no-op when push is unconfigured. Stale subscriptions (404/410 from the push
// service) are pruned as we discover them.
export const sendDeploymentNotification = async (project: Project, state: DeploymentState): Promise<void> => {
    if (!cluster.isLeader() || !isPushConfigured()) return;
    initWebPush();

    const copy = copyForState(project, state);
    if (!copy) return;

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
};
