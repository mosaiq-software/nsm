import cron, { ScheduledTask } from 'node-cron';
import { CdTrigger } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { enqueueDeploy } from '@/controllers/deployQueue';
import { getAllProjects } from '@/controllers/projectController';
import { areaLog } from '@/utils/log';

const schedLog = areaLog('cd-schedule');

// SCHEDULE triggers have no GitHub webhook equivalent, so NSM drives them with node-cron on the
// leader. Tasks are keyed by projectId so a re-setup or removal can replace/stop the prior task.
const tasks = new Map<string, ScheduledTask>();

// Register (or replace) the cron task that enqueues a scheduled deploy for a project. The task only
// fires on the leader, so it is safe to register on every node.
export const registerScheduledDeploy = (projectId: string, expr: string): void => {
    unregisterScheduledDeploy(projectId);
    if (!cron.validate(expr)) {
        schedLog.warn({ action: 'cd_schedule_invalid', projectId, expr }, `invalid cron for ${projectId}, not scheduling`);
        return;
    }
    const task = cron.schedule(expr, () => {
        if (!cluster.isLeader()) return;
        schedLog.info({ action: 'cd_schedule_fired', projectId, expr }, `scheduled deploy firing for ${projectId}`);
        void enqueueDeploy(projectId).catch((e) => schedLog.error({ action: 'cd_schedule_deploy_failed', projectId, err: e?.message }, `scheduled deploy failed for ${projectId}`));
    });
    tasks.set(projectId, task);
    schedLog.info({ action: 'cd_schedule_registered', projectId, expr }, `registered scheduled deploy for ${projectId}`);
};

// Stop and drop a project's scheduled deploy task, if any.
export const unregisterScheduledDeploy = (projectId: string): void => {
    const existing = tasks.get(projectId);
    if (!existing) return;
    existing.stop();
    tasks.delete(projectId);
    schedLog.info({ action: 'cd_schedule_unregistered', projectId }, `unregistered scheduled deploy for ${projectId}`);
};

// Rebuild the schedule registry from persisted CD config. Called once at startup so scheduled
// deploys survive restarts and leadership changes.
export const initCdSchedules = async (): Promise<void> => {
    const projects = await getAllProjects();
    let count = 0;
    for (const project of projects) {
        const cd = project.cicd;
        if (cd?.managed && cd.triggers.includes(CdTrigger.SCHEDULE) && cd.cron) {
            registerScheduledDeploy(project.id, cd.cron);
            count++;
        }
    }
    schedLog.info({ action: 'cd_schedules_initialized', count }, `initialized ${count} scheduled deploy(s)`);
};
