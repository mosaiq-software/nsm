import { ClusterStatus } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { getDeployQueueState } from './deployQueue';

// Cluster status: liveness comes from the leader-hosted registry + status gossip heartbeats. The
// deploy queue is leader-local; on a follower it is empty (followers never deploy).
export const getControlPlaneStatus = async (): Promise<ClusterStatus> => {
    const status = await cluster.status();
    return { ...status, deployQueue: getDeployQueueState() };
};
