import { CdConfig, CdSetupRequest, CdTrigger, Project } from '@mosaiq/nsm-common/types';
import { isGithubAppConfigured } from '@/config';
import { getProject, updateProjectNoDirty } from '@/controllers/projectController';
import { registerScheduledDeploy, unregisterScheduledDeploy } from '@/controllers/cdScheduler';
import { ensureGithubWebhook, removeGithubWebhookIfUnused } from '@/controllers/githubWebhookProvisioning';
import { areaLog } from '@/utils/log';

const cicdLog = areaLog('cicd');

// Provision managed CD for a project: ensure the shared GitHub repository webhook exists (NSM
// ingests every event and evaluates CD conditions server-side) and, for SCHEDULE, an internal cron
// task. Persists a snapshot of the configuration on the project and enables CI/CD. Leader-only.
export const setupManagedCd = async (projectId: string, req: CdSetupRequest): Promise<Project | undefined> => {
    if (!isGithubAppConfigured()) throw new Error('The NSM GitHub App is not configured on this node.');
    const project = await getProject(projectId);
    if (!project) return undefined;

    // Re-setup: replace the schedule; the shared webhook is unaffected (it subscribes to all events).
    if (project.cicd?.managed) unregisterScheduledDeploy(projectId);

    const cd: CdConfig = {
        managed: true,
        branch: req.branch,
        triggers: req.triggers,
        branches: req.branches,
        tagPattern: req.tagPattern,
        cron: req.cron,
        setupAt: Date.now(),
    };

    await updateProjectNoDirty(projectId, { allowCICD: true, cicd: cd });

    // Any webhook-backed trigger needs the shared GitHub webhook; a SCHEDULE-only pipeline does not.
    const needsWebhook = req.triggers.some((t) => t !== CdTrigger.SCHEDULE);
    if (needsWebhook) await ensureGithubWebhook(projectId);

    if (req.triggers.includes(CdTrigger.SCHEDULE) && req.cron) registerScheduledDeploy(projectId, req.cron);

    cicdLog.info({ action: 'cicd_setup', projectId, triggers: req.triggers }, `managed CD set up for ${projectId}`);
    return await getProject(projectId);
};

// Remove a project's managed CD: stop the internal cron task, clear the snapshot, and drop the shared
// GitHub webhook if no other consumer (notifications) still needs it. Leaves allowCICD for the user
// to toggle in config. Leader-only.
export const removeManagedCd = async (projectId: string): Promise<Project | undefined> => {
    if (!isGithubAppConfigured()) throw new Error('The NSM GitHub App is not configured on this node.');
    const project = await getProject(projectId);
    if (!project) return undefined;
    unregisterScheduledDeploy(projectId);

    await updateProjectNoDirty(projectId, { cicd: undefined });
    await removeGithubWebhookIfUnused(projectId);

    cicdLog.info({ action: 'cicd_removed', projectId }, `managed CD removed for ${projectId}`);
    return await getProject(projectId);
};
