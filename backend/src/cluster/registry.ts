import { config } from '@/config';
import { getPrimaryIp } from '@/host/exec';
import { touchNodeModel, getAllNodesModel, deleteNodeModel, getNodeByIdModel } from '@/persistence/nodePersistence';
import { postToLeader } from './leaderClient';
import { cluster } from './node';
import { areaLog } from '@/utils/log';

const registryLog = areaLog('registry');

export interface RegisterRequest {
    nodeId: string;
    address: string;
    apiPort: number;
}

export interface RegistryNode {
    nodeId: string;
    address: string;
    apiPort: number;
    isLeader: boolean;
}

export interface RegistrySnapshot {
    nodes: RegistryNode[];
}

// LEADER side: upsert a node row and stamp lastSeen. Registering the same nodeId with a new
// address is how an IP change propagates into the registry.
export const registerNode = async (req: RegisterRequest): Promise<void> => {
    if (!req?.nodeId || !req?.address) {
        registryLog.warn({ action: 'registration_rejected', nodeId: req?.nodeId, address: req?.address }, 'rejected invalid node registration');
        throw new Error('invalid-registration');
    }
    const isLeader = req.nodeId === config.nodeId && cluster.isLeader();
    await touchNodeModel(req.nodeId, req.address, req.apiPort, isLeader);
    registryLog.info({ action: 'node_registered', nodeId: req.nodeId, address: req.address, apiPort: req.apiPort, isLeader }, `node ${req.nodeId} registered`);
};

export const deregisterNode = async (nodeId: string): Promise<void> => {
    await deleteNodeModel(nodeId);
    registryLog.info({ action: 'node_deregistered', nodeId }, `node ${nodeId} deregistered`);
};

export const getRegistry = async (): Promise<RegistrySnapshot> => ({
    nodes: (await getAllNodesModel()).map((n) => ({ nodeId: n.nodeId, address: n.address, apiPort: n.apiPort, isLeader: n.isLeader })),
});

// ANY node at boot: ensure a self row exists. The leader writes locally; a follower announces
// itself to the leader over HTTP.
export const ensureSelfRegistered = async (): Promise<void> => {
    const address = await getPrimaryIp();
    if (cluster.isLeader()) {
        await touchNodeModel(config.nodeId, address, config.apiPort, true);
        registryLog.info({ action: 'self_registered', nodeId: config.nodeId, address, apiPort: config.apiPort, role: 'leader' }, 'self-registered as leader');
    } else {
        const res = await postToLeader('/cluster/register', { nodeId: config.nodeId, address, apiPort: config.apiPort });
        if (res) registryLog.info({ action: 'self_registered', nodeId: config.nodeId, address, apiPort: config.apiPort, role: 'follower' }, 'announced self to leader');
        else registryLog.warn({ action: 'self_register_failed', nodeId: config.nodeId, leaderAddress: cluster.leaderAddress() }, 'failed to announce self to leader');
    }
};

export { getNodeByIdModel };
