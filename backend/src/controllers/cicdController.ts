import * as crypto from 'crypto';
import { CdConfig, CdSetupRequest, CdTrigger, Project } from '@mosaiq/nsm-common/types';
import { config, isGithubAppConfigured } from '@/config';
import { getProject, updateProjectNoDirty } from '@/controllers/projectController';
import { registerScheduledDeploy, unregisterScheduledDeploy } from '@/controllers/cdScheduler';
import { createRepoWebhook, deleteRepoWebhook } from '@/utils/githubApp';
import { areaLog } from '@/utils/log';

const cicdLog = areaLog('cicd');

// The NSM URL GitHub delivers this project's webhook events to.
const deliveryUrlForProject = (projectId: string): string => `${config.publicUrl.replace(/\/$/, '')}/github/webhook/${projectId}`;

// Map the selected CD triggers to the GitHub webhook event types the hook should subscribe to. Finer
// conditions (branch, tag glob, PR-merged) are evaluated in the receiver; SCHEDULE has no webhook
// event (it is driven by node-cron on the leader).
const githubEventsForTriggers = (triggers: CdTrigger[]): string[] => {
    const events = new Set<string>();
    if (triggers.includes(CdTrigger.PUSH) || triggers.includes(CdTrigger.TAG)) events.add('push');
    if (triggers.includes(CdTrigger.PR_MERGE)) events.add('pull_request');
    if (triggers.includes(CdTrigger.RELEASE)) events.add('release');
    return [...events];
};

// Provision managed CD for a project: register a GitHub repository webhook (secret + event filter)
// that NSM listens to, and (for SCHEDULE) an internal cron task. Persists a snapshot of the
// configuration on the project and enables CI/CD. Leader-only (App private key).
export const setupManagedCd = async (projectId: string, req: CdSetupRequest): Promise<Project | undefined> => {
    if (!isGithubAppConfigured()) throw new Error('The NSM GitHub App is not configured on this node.');
    const project = await getProject(projectId);
    if (!project) return undefined;

    const owner = project.repoOwner;
    const repo = project.repoName;

    // Re-setup: drop any prior webhook/schedule so we don't leave a duplicate hook behind.
    if (project.cicd?.managed) {
        if (project.cicd.webhookId) {
            await deleteRepoWebhook(owner, repo, project.cicd.webhookId).catch((e: any) =>
                cicdLog.warn({ action: 'cicd_replace_hook_delete_failed', projectId, err: e?.message }, `failed to delete prior webhook for ${projectId}`)
            );
        }
        unregisterScheduledDeploy(projectId);
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const deliveryUrl = deliveryUrlForProject(projectId);
    const events = githubEventsForTriggers(req.triggers);

    // A webhook is only registered when at least one webhook-backed trigger is selected. A
    // SCHEDULE-only pipeline has no GitHub events, so it registers just the internal cron task.
    let webhookId = 0;
    if (events.length > 0) {
        webhookId = await createRepoWebhook(owner, repo, deliveryUrl, webhookSecret, events);
    }

    const cd: CdConfig = {
        managed: true,
        branch: req.branch,
        triggers: req.triggers,
        branches: req.branches,
        tagPattern: req.tagPattern,
        cron: req.cron,
        webhookId,
        webhookSecret,
        deliveryUrl,
        setupAt: Date.now(),
    };

    if (req.triggers.includes(CdTrigger.SCHEDULE) && req.cron) registerScheduledDeploy(projectId, req.cron);

    await updateProjectNoDirty(projectId, { allowCICD: true, cicd: cd });
    cicdLog.info({ action: 'cicd_setup', projectId, triggers: req.triggers, events }, `managed CD set up for ${projectId}`);
    return await getProject(projectId);
};

// Remove a project's managed CD: delete the GitHub webhook, stop the internal cron task, and clear
// the snapshot. Leaves allowCICD for the user to toggle in config. Leader-only (App private key).
export const removeManagedCd = async (projectId: string): Promise<Project | undefined> => {
    if (!isGithubAppConfigured()) throw new Error('The NSM GitHub App is not configured on this node.');
    const project = await getProject(projectId);
    if (!project) return undefined;
    unregisterScheduledDeploy(projectId);
    const cd = project.cicd;
    if (!cd || !cd.managed) {
        await updateProjectNoDirty(projectId, { cicd: undefined });
        return await getProject(projectId);
    }

    if (cd.webhookId) {
        await deleteRepoWebhook(project.repoOwner, project.repoName, cd.webhookId).catch((e: any) =>
            cicdLog.warn({ action: 'cicd_remove_hook_failed', projectId, err: e?.message }, `failed to delete webhook for ${projectId}`)
        );
    }

    await updateProjectNoDirty(projectId, { cicd: undefined });
    cicdLog.info({ action: 'cicd_removed', projectId }, `managed CD removed for ${projectId}`);
    return await getProject(projectId);
};
