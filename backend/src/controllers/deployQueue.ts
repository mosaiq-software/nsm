import { DeploymentState, DeployQueueEntry, DeployQueueState } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getProject } from './projectController';
import { deployProject, updateDeploymentLog } from './deployController';
import { sendDeploymentNotification } from './pushController';
import { createProjectInstanceModel, getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';
import { areaLog } from '@/utils/log';

const queueLog = areaLog('deployQueue');

// Leader-local serial deploy queue. Only the leader deploys, and only one deploy runs at a time:
// this removes the port-allocation race between concurrent deploys (free ports are detected from
// live sockets, so two plans running at once could hand the same port to two projects) and gives a
// predictable, observable ordering. State is in-memory; QUEUED ProjectInstances in the DB let the
// queue survive a leader restart via recoverDeployQueue().
let queue: DeployQueueEntry[] = [];
let active: (DeployQueueEntry & { startedAt: number }) | null = null;
let draining = false;

// Instances flagged for cancellation while still in the leader's queue/planning phase. Consulted by
// drainQueue (skip a flagged entry before dequeue) and by deployProject (abort before it proposes
// the desired deployment). The building phase is cancelled on the owning node, not via this set.
const canceledInstances = new Set<string>();
export const isInstanceCanceled = (instanceId: string): boolean => canceledInstances.has(instanceId);
export const clearInstanceCanceled = (instanceId: string): void => {
    canceledInstances.delete(instanceId);
};

// Delay inserted between consecutive deploys to space out queue processing.
const INTER_DEPLOY_DELAY_MS = 30_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Enqueue a project for deployment. Deduplicates: a project that is already deploying or already
// queued keeps its existing instance (so re-triggering a webhook/click doesn't stack duplicates).
// Returns the ProjectInstance/log id, created immediately so the UI can watch from QUEUED onward.
export const enqueueDeploy = async (projectId: string): Promise<string | undefined> => {
    if (!cluster.isLeader()) throw new Error('enqueueDeploy must run on the leader');

    if (active?.projectId === projectId) {
        queueLog.info({ action: 'deploy_deduplicated', projectId, instanceId: active.instanceId, reason: 'active' }, `deploy for ${projectId} already active`);
        return active.instanceId;
    }
    const existing = queue.find((e) => e.projectId === projectId);
    if (existing) {
        queueLog.info({ action: 'deploy_deduplicated', projectId, instanceId: existing.instanceId, reason: 'queued' }, `deploy for ${projectId} already queued`);
        return existing.instanceId;
    }

    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    const instanceId = crypto.randomUUID();
    await createProjectInstanceModel({
        id: instanceId,
        projectId,
        workerNodeId: project.workerNodeId ?? '',
        state: DeploymentState.QUEUED,
        created: Date.now(),
        lastUpdated: Date.now(),
        active: true,
        directories: {},
    });

    queue.push({ projectId, instanceId, enqueuedAt: Date.now() });
    queueLog.info({ action: 'deploy_enqueued', projectId, instanceId, queueDepth: queue.length }, `enqueued deploy for ${projectId} (depth ${queue.length})`);
    void sendDeploymentNotification(project, DeploymentState.QUEUED);
    void drainQueue();
    return instanceId;
};

const drainQueue = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
        let first = true;
        while (queue.length > 0) {
            if (!first) await delay(INTER_DEPLOY_DELAY_MS);
            first = false;
            const entry = queue.shift()!;
            if (canceledInstances.has(entry.instanceId)) {
                clearInstanceCanceled(entry.instanceId);
                queueLog.info({ action: 'deploy_skip_canceled', projectId: entry.projectId, instanceId: entry.instanceId }, `skipping canceled deploy for ${entry.projectId}`);
                continue;
            }
            active = { ...entry, startedAt: Date.now() };
            queueLog.info({ action: 'deploy_dequeued', projectId: entry.projectId, instanceId: entry.instanceId, queueDepth: queue.length }, `dequeued deploy for ${entry.projectId}`);
            try {
                await deployProject(entry.projectId, entry.instanceId);
                queueLog.info({ action: 'deploy_drain_completed', projectId: entry.projectId, instanceId: entry.instanceId, durationMs: Date.now() - active.startedAt }, `deploy drain completed for ${entry.projectId}`);
            } catch (error: any) {
                // deployProject already records FAILED on its own errors; this is a backstop for
                // anything thrown before that (e.g. project vanished between enqueue and drain).
                queueLog.error({ action: 'deploy_drain_failed', projectId: entry.projectId, instanceId: entry.instanceId, err: error?.message }, `deploy drain failed for ${entry.projectId}`);
                await updateDeploymentLog(entry.instanceId, DeploymentState.FAILED, `Deploy failed: ${error?.message}\n`).catch(() => {});
            } finally {
                active = null;
            }
        }
    } finally {
        draining = false;
    }
};

// Cancel a deploy that has not yet been handed to its node. Returns which phase it was in:
//   'queued'   - still waiting: removed from the queue and marked CANCELLED here (fully handled).
//   'planning' - occupying the leader's planning slot: flagged so deployProject aborts before it
//                proposes the desired deployment. The caller finishes the cancel.
//   'none'     - not in the queue or planning slot: it is already building on its node.
export const cancelQueuedDeploy = async (projectId: string): Promise<'queued' | 'planning' | 'none'> => {
    const idx = queue.findIndex((e) => e.projectId === projectId);
    if (idx >= 0) {
        const [entry] = queue.splice(idx, 1);
        queueLog.info({ action: 'deploy_cancel_queued', projectId, instanceId: entry.instanceId, queueDepth: queue.length }, `cancelled queued deploy for ${projectId}`);
        await updateDeploymentLog(entry.instanceId, DeploymentState.CANCELLED, 'Deployment cancelled while queued.\n').catch(() => {});
        return 'queued';
    }
    if (active?.projectId === projectId) {
        canceledInstances.add(active.instanceId);
        queueLog.info({ action: 'deploy_cancel_planning', projectId, instanceId: active.instanceId }, `flagged planning deploy for ${projectId} to cancel`);
        return 'planning';
    }
    return 'none';
};

export const getDeployQueueState = (): DeployQueueState => ({
    active: active ? { ...active } : null,
    queued: queue.map((e) => ({ ...e })),
    deploying: [],
});

// On leader startup, re-enqueue any ProjectInstances left in QUEUED (the in-memory queue is lost on
// restart, but the DB rows persist). Preserves original order by enqueue time.
export const recoverDeployQueue = async (): Promise<void> => {
    if (!cluster.isLeader()) return;
    const instances = (await getAllActiveProjectInstancesModel())
        .filter((inst) => inst.state === DeploymentState.QUEUED)
        .sort((a, b) => a.created - b.created);
    for (const inst of instances) {
        if (active?.projectId === inst.projectId) continue;
        if (queue.some((e) => e.projectId === inst.projectId)) continue;
        queue.push({ projectId: inst.projectId, instanceId: inst.id, enqueuedAt: inst.created });
    }
    if (queue.length > 0) {
        queueLog.info({ action: 'queue_recovered', recoveredCount: queue.length, projectIds: queue.map((e) => e.projectId) }, `recovered ${queue.length} queued deploy(s)`);
        void drainQueue();
    }
};
