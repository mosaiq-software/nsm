import { sequelize } from '@/utils/dbHelper';
import { ClusterNode } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// The node registry. On the leader this is the authoritative nodeId -> current IP map.
class NodeModel extends Model {}
NodeModel.init(
    {
        nodeId: { type: DataTypes.STRING, primaryKey: true },
        address: DataTypes.STRING,
        apiPort: DataTypes.NUMBER,
        lastSeen: DataTypes.NUMBER,
        isLeader: DataTypes.BOOLEAN,
    },
    { sequelize, timestamps: false }
);

export const upsertNodeModel = async (node: ClusterNode): Promise<void> => {
    const existing = await NodeModel.findByPk(node.nodeId);
    if (existing) {
        await existing.update({ ...node });
    } else {
        await NodeModel.create({ ...node });
    }
};

// Upsert a node's current address and stamp lastSeen. Used on registration + heartbeat so an
// IP change for a stable nodeId propagates into the registry within one interval.
export const touchNodeModel = async (nodeId: string, address: string, apiPort: number, isLeader: boolean): Promise<void> => {
    await upsertNodeModel({ nodeId, address, apiPort, isLeader, lastSeen: Date.now() });
};

export const getAllNodesModel = async (): Promise<ClusterNode[]> => {
    return (await NodeModel.findAll())?.map((n) => n.toJSON()) as ClusterNode[];
};

export const getNodeByIdModel = async (nodeId: string): Promise<ClusterNode | null> => {
    return (await NodeModel.findByPk(nodeId))?.toJSON() as ClusterNode | null;
};

export const deleteNodeModel = async (nodeId: string): Promise<void> => {
    await NodeModel.destroy({ where: { nodeId } });
};
