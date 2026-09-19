import crypto from 'crypto';
import { Project } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { getProject, updateProjectNoDirty } from '@/controllers/projectController';
import { getWebhooksByProjectModel } from '@/persistence/projectWebhookPersistence';
import { createRepoWebhook, deleteRepoWebhook } from '@/utils/githubApp';
import { sha256Hex } from '@/utils/hash';
import { areaLog } from '@/utils/log';

const provLog = areaLog('github-webhook-provision');

// The NSM URL GitHub delivers this project's events to. The path token authenticates the delivery;
// only its SHA-256 hash is stored, so the raw token exists only in the registered GitHub hook config.
const deliveryUrl = (projectId: string, token: string): string => `${config.publicUrl.replace(/\/$/, '')}/github/webhook/${projectId}/${token}`;

// Whether anything still needs the shared GitHub webhook: managed CD, or any Discord webhook that
// subscribes to at least one GitHub scenario. When false the hook can be safely removed.
export const webhookConsumersExist = async (project: Project): Promise<boolean> => {
    if (project.cicd?.managed) return true;
    const webhooks = await getWebhooksByProjectModel(project.id);
    return webhooks.some((w) => (w.githubScenarios?.length ?? 0) > 0);
};

// Ensure the shared GitHub repository webhook exists for a project, registering it (subscribed to all
// events via `['*']`) on first use. Idempotent: returns undefined when already provisioned. On
// creation it returns the one-time delivery URL (containing the raw token) for display. Leader-only.
export const ensureGithubWebhook = async (projectId: string): Promise<string | undefined> => {
    const project = await getProject(projectId);
    if (!project) return undefined;
    if (project.githubWebhook) return undefined;

    const token = crypto.randomBytes(24).toString('hex');
    const url = deliveryUrl(projectId, token);
    const hookId = await createRepoWebhook(project.repoOwner, project.repoName, url, ['*']);
    await updateProjectNoDirty(projectId, { githubWebhook: { hookId, tokenHash: sha256Hex(token) } });
    provLog.info({ action: 'github_webhook_provisioned', projectId, hookId }, `provisioned shared GitHub webhook for ${projectId}`);
    return url;
};

// Delete the shared GitHub repository webhook when no consumer remains (no managed CD, no GitHub
// notification scenarios). Best-effort on the GitHub side; always clears the stored ref. Leader-only.
export const removeGithubWebhookIfUnused = async (projectId: string): Promise<void> => {
    const project = await getProject(projectId);
    if (!project?.githubWebhook) return;
    if (await webhookConsumersExist(project)) return;

    await deleteRepoWebhook(project.repoOwner, project.repoName, project.githubWebhook.hookId).catch((e: any) =>
        provLog.warn({ action: 'github_webhook_delete_failed', projectId, err: e?.message }, `failed to delete GitHub webhook for ${projectId}`)
    );
    await updateProjectNoDirty(projectId, { githubWebhook: undefined });
    provLog.info({ action: 'github_webhook_deprovisioned', projectId }, `removed shared GitHub webhook for ${projectId}`);
};
