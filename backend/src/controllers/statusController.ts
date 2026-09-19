import { ClusterStatus, DeployQueueEntry, DeployQueueState, DeploymentState, User } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getDeployQueueState, INTER_DEPLOY_DELAY_MS } from './deployQueue';
import { getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';
import { getVisibleProjects } from './teamController';
import { getProjectDeployAverage } from './deployEstimates';

// Redact a queue entry the requesting user cannot see into a placeholder that keeps only its
// position: identifying fields (projectId/instanceId), timestamps, and ETA estimates are cleared so
// the UI can show honest queue counts without leaking other teams' project ids or deploy timings.
const redactEntry = <T extends DeployQueueEntry>(entry: T, visible: Set<string>): T => {
    if (visible.has(entry.projectId)) return entry;
    return { ...entry, projectId: '', instanceId: '', enqueuedAt: 0, startedAt: 0, hidden: true, estimatedWaitMs: undefined, estimatedDeployMs: undefined, avgSampleCount: undefined };
};

const redactQueue = (queue: DeployQueueState, visible: Set<string>): DeployQueueState => ({
    active: queue.active ? redactEntry(queue.active, visible) : null,
    queued: queue.queued.map((e) => redactEntry(e, visible)),
    deploying: queue.deploying.map((e) => redactEntry(e, visible)),
});

// Per-project average of recent successful deploy durations, plus how many samples backed it. A
// cross-project fallback (mean of every project's average) is used for projects with no history yet,
// so a brand-new project still gets a rough estimate.
const buildAverages = async (
    projectIds: string[]
): Promise<{ avgFor: (projectId: string) => { deployMs: number | undefined; sampleCount: number } }> => {
    const avg = new Map<string, number>();
    const count = new Map<string, number>();
    for (const projectId of new Set(projectIds)) {
        const { deployMs, sampleCount } = await getProjectDeployAverage(projectId);
        count.set(projectId, sampleCount);
        if (deployMs != null) avg.set(projectId, deployMs);
    }
    const known = [...avg.values()];
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined;
    return {
        avgFor: (projectId: string) => {
            const sampleCount = count.get(projectId) ?? 0;
            if (sampleCount > 0) return { deployMs: avg.get(projectId), sampleCount };
            return { deployMs: fallback, sampleCount: 0 };
        },
    };
};

// Annotate the queue with deploy-time estimates. Because the queue is strictly serial (one full
// deploy at a time, spaced by INTER_DEPLOY_DELAY_MS), the wait until a queued item begins deploying
// is the remaining time on the in-flight deploy plus the sum of the averages (each plus the buffer)
// of the items ahead of it.
export const annotateQueueEtas = async (queue: DeployQueueState): Promise<void> => {
    const projectIds = [
        ...(queue.active ? [queue.active.projectId] : []),
        ...queue.deploying.map((e) => e.projectId),
        ...queue.queued.map((e) => e.projectId),
    ];
    const { avgFor } = await buildAverages(projectIds);
    const now = Date.now();

    // The single in-flight deploy: the build shown in `deploying`, or the brief planning slot if no
    // build has been reported yet.
    const inflight = queue.deploying[0] ?? queue.active ?? null;
    let remainingMs = 0;
    if (inflight) {
        const { deployMs } = avgFor(inflight.projectId);
        const elapsed = now - (inflight.startedAt ?? now);
        remainingMs = deployMs != null ? Math.max(0, deployMs - elapsed) : 0;
    }

    // In-flight entries: no wait, and their own expected deploy time.
    for (const entry of queue.deploying) {
        const { deployMs, sampleCount } = avgFor(entry.projectId);
        entry.estimatedWaitMs = 0;
        entry.estimatedDeployMs = deployMs;
        entry.avgSampleCount = sampleCount;
    }
    if (queue.active) {
        const { deployMs, sampleCount } = avgFor(queue.active.projectId);
        queue.active.estimatedWaitMs = 0;
        queue.active.estimatedDeployMs = deployMs;
        queue.active.avgSampleCount = sampleCount;
    }

    // Queued entries: cumulative wait until each reaches the top and begins deploying. When something
    // is in flight, the first queued item waits for it to finish plus one buffer; with an idle queue
    // the first item starts immediately.
    let cumulativeMs = inflight ? remainingMs + INTER_DEPLOY_DELAY_MS : 0;
    for (const entry of queue.queued) {
        const { deployMs, sampleCount } = avgFor(entry.projectId);
        entry.estimatedWaitMs = cumulativeMs;
        entry.estimatedDeployMs = deployMs;
        entry.avgSampleCount = sampleCount;
        cumulativeMs += (deployMs ?? 0) + INTER_DEPLOY_DELAY_MS;
    }
};

// Cluster status: liveness comes from the leader-hosted registry + status gossip heartbeats. The
// deploy queue is leader-local; on a follower it is empty (followers never deploy). `deploying` is
// derived from the leader's ProjectInstances that are currently building (DEPLOYING), so it reflects
// the whole build - not just the brief leader planning slot tracked by `active`.
//
// The deploy queue is redacted to the requesting user's visible projects: entries for projects they
// cannot view keep their position but are stripped of identifying details (see redactEntry).
export const getControlPlaneStatus = async (user: User | null): Promise<ClusterStatus> => {
    const status = await cluster.status();
    const deployQueue = getDeployQueueState();
    const instances = await getAllActiveProjectInstancesModel();
    deployQueue.deploying = instances
        .filter((inst) => inst.state === DeploymentState.DEPLOYING)
        .sort((a, b) => a.created - b.created)
        .map((inst) => ({ projectId: inst.projectId, instanceId: inst.id, enqueuedAt: inst.created, startedAt: inst.created }));
    await annotateQueueEtas(deployQueue);
    const visible = new Set((user ? await getVisibleProjects(user) : []).map((p) => p.id));
    return { ...status, deployQueue: redactQueue(deployQueue, visible) };
};
