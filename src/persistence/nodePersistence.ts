import { sequelize } from '@/utils/dbHelper';
import { ClusterNode } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

class NodeModel extends Model {}
NodeModel.init(
    {
        nodeId: { type: DataTypes.STRING, primaryKey: true },
        address: DataTypes.STRING,
        raftPort: DataTypes.NUMBER,
        apiPort: DataTypes.NUMBER,
        voter: DataTypes.BOOLEAN,
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

export const getAllNodesModel = async (): Promise<ClusterNode[]> => {
    return (await NodeModel.findAll())?.map((n) => n.toJSON()) as ClusterNode[];
};

export const getNodeByIdModel = async (nodeId: string): Promise<ClusterNode | null> => {
    return (await NodeModel.findByPk(nodeId))?.toJSON() as ClusterNode | null;
};

export const deleteNodeModel = async (nodeId: string): Promise<void> => {
    await NodeModel.destroy({ where: { nodeId } });
};
