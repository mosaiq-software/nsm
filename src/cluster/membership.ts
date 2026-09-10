import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';
import { config, loadClusterFile } from '@/config';
import { cluster } from './node';

export interface JoinRequest {
    node: NodeInfo;
    token: string;
}

export interface JoinResponse {
    ok: boolean;
    error?: string;
    cluster?: ReturnType<typeof loadClusterFile>;
}

// Leader-side handling of a new node joining. The join token is the shared cluster secret.
export const handleJoin = async (req: JoinRequest): Promise<JoinResponse> => {
    if (!cluster.isLeader()) return { ok: false, error: 'not-leader' };
    if (req.token !== config.clusterSecret) return { ok: false, error: 'invalid-token' };
    if (!req.node?.nodeId || !req.node?.address) return { ok: false, error: 'invalid-node' };
    try {
        await cluster.addNode(req.node);
        return { ok: true, cluster: loadClusterFile() };
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
};

export const handleRemove = async (nodeId: string): Promise<{ ok: boolean; error?: string }> => {
    if (!cluster.isLeader()) return { ok: false, error: 'not-leader' };
    try {
        await cluster.removeNode(nodeId);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
};
