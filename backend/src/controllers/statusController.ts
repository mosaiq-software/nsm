import { ClusterStatus } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';

// Cluster status: liveness comes from the leader-hosted registry + status gossip heartbeats.
export const getControlPlaneStatus = async (): Promise<ClusterStatus> => {
    return await cluster.status();
};
