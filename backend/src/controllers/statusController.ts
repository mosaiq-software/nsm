import { ClusterStatus, DeploymentState } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getDeployQueueState } from './deployQueue';
import { getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';

// Cluster status: liveness comes from the leader-hosted registry + status gossip heartbeats. The
// deploy queue is leader-local; on a follower it is empty (followers never deploy). `deploying` is
// derived from the leader's ProjectInstances that are currently building (DEPLOYING), so it reflects
// the whole build - not just the brief leader planning slot tracked by `active`.
export const getControlPlaneStatus = async (): Promise<ClusterStatus> => {
    const status = await cluster.status();
    const deployQueue = getDeployQueueState();
    const instances = await getAllActiveProjectInstancesModel();
    deployQueue.deploying = instances
        .filter((inst) => inst.state === DeploymentState.DEPLOYING)
        .sort((a, b) => a.created - b.created)
        .map((inst) => ({ projectId: inst.projectId, instanceId: inst.id, enqueuedAt: inst.created, startedAt: inst.created }));
    return { ...status, deployQueue };
};
