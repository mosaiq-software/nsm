import { ClusterStatus } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';

// Cluster status replaces the old single control-plane heartbeat/incident tracking.
// Liveness now comes from raft heartbeats + keepalived VRRP + status gossip.
export const getControlPlaneStatus = async (): Promise<ClusterStatus> => {
    return await cluster.status();
};
