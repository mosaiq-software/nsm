import { ClusterStatus, DeployQueueEntry, DeployQueueState, DeploymentState, User } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getDeployQueueState } from './deployQueue';
import { getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';
import { getVisibleProjects } from './teamController';

// Redact a queue entry the requesting user cannot see into a placeholder that keeps only its
// position: identifying fields (projectId/instanceId) and timestamps are cleared so the UI can show
// honest queue counts without leaking other teams' project ids.
const redactEntry = <T extends DeployQueueEntry>(entry: T, visible: Set<string>): T => {
    if (visible.has(entry.projectId)) return entry;
    return { ...entry, projectId: '', instanceId: '', enqueuedAt: 0, startedAt: 0, hidden: true };
};

const redactQueue = (queue: DeployQueueState, visible: Set<string>): DeployQueueState => ({
    active: queue.active ? redactEntry(queue.active, visible) : null,
    queued: queue.queued.map((e) => redactEntry(e, visible)),
    deploying: queue.deploying.map((e) => redactEntry(e, visible)),
});

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
    const visible = new Set((user ? await getVisibleProjects(user) : []).map((p) => p.id));
    return { ...status, deployQueue: redactQueue(deployQueue, visible) };
};
