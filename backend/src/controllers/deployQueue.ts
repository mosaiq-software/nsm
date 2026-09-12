import { DeploymentState, DeployQueueEntry, DeployQueueState } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getProject } from './projectController';
import { deployProject, updateDeploymentLog } from './deployController';
import { sendDeploymentNotification } from './pushController';
import { createProjectInstanceModel, getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';

// Leader-local serial deploy queue. Only the leader deploys, and only one deploy runs at a time:
// this removes the port-allocation race between concurrent deploys (free ports are detected from
// live sockets, so two plans running at once could hand the same port to two projects) and gives a
// predictable, observable ordering. State is in-memory; QUEUED ProjectInstances in the DB let the
// queue survive a leader restart via recoverDeployQueue().
let queue: DeployQueueEntry[] = [];
let active: (DeployQueueEntry & { startedAt: number }) | null = null;
let draining = false;

// Delay inserted between consecutive deploys to space out queue processing.
const INTER_DEPLOY_DELAY_MS = 30_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Enqueue a project for deployment. Deduplicates: a project that is already deploying or already
// queued keeps its existing instance (so re-triggering a webhook/click doesn't stack duplicates).
// Returns the ProjectInstance/log id, created immediately so the UI can watch from QUEUED onward.
export const enqueueDeploy = async (projectId: string): Promise<string | undefined> => {
    if (!cluster.isLeader()) throw new Error('enqueueDeploy must run on the leader');

    if (active?.projectId === projectId) return active.instanceId;
    const existing = queue.find((e) => e.projectId === projectId);
    if (existing) return existing.instanceId;

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
            active = { ...entry, startedAt: Date.now() };
            try {
                await deployProject(entry.projectId, entry.instanceId);
            } catch (error: any) {
                // deployProject already records FAILED on its own errors; this is a backstop for
                // anything thrown before that (e.g. project vanished between enqueue and drain).
                console.error('[deployQueue] deploy failed', entry.projectId, error?.message);
                await updateDeploymentLog(entry.instanceId, DeploymentState.FAILED, `Deploy failed: ${error?.message}\n`).catch(() => {});
            } finally {
                active = null;
            }
        }
    } finally {
        draining = false;
    }
};

export const getDeployQueueState = (): DeployQueueState => ({
    active: active ? { ...active } : null,
    queued: queue.map((e) => ({ ...e })),
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
        console.log(`[deployQueue] recovered ${queue.length} queued deploy(s)`);
        void drainQueue();
    }
};
