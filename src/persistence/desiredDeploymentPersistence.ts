import { sequelize } from '@/utils/dbHelper';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';
import { DataTypes, Model } from 'sequelize';

class DesiredDeploymentModel extends Model {}
DesiredDeploymentModel.init(
    {
        projectId: { type: DataTypes.STRING, primaryKey: true },
        generation: DataTypes.NUMBER,
        assignedNodeId: DataTypes.STRING,
        json: DataTypes.TEXT,
    },
    { sequelize, timestamps: false }
);

export const upsertDesiredDeploymentModel = async (dep: DesiredDeployment): Promise<void> => {
    const row = { projectId: dep.projectId, generation: dep.generation, assignedNodeId: dep.assignedNodeId, json: JSON.stringify(dep) };
    const existing = await DesiredDeploymentModel.findByPk(dep.projectId);
    if (existing) {
        await existing.update(row);
    } else {
        await DesiredDeploymentModel.create(row);
    }
};

const toDep = (m: any): DesiredDeployment => JSON.parse(m.json) as DesiredDeployment;

export const getDesiredDeploymentModel = async (projectId: string): Promise<DesiredDeployment | null> => {
    const m = (await DesiredDeploymentModel.findByPk(projectId))?.toJSON();
    return m ? toDep(m) : null;
};

export const getAllDesiredDeploymentsModel = async (): Promise<DesiredDeployment[]> => {
    return (await DesiredDeploymentModel.findAll())?.map((m) => toDep(m.toJSON()));
};

export const getDesiredDeploymentsAssignedToModel = async (nodeId: string): Promise<DesiredDeployment[]> => {
    return (await DesiredDeploymentModel.findAll({ where: { assignedNodeId: nodeId } }))?.map((m) => toDep(m.toJSON()));
};

export const deleteDesiredDeploymentModel = async (projectId: string): Promise<void> => {
    await DesiredDeploymentModel.destroy({ where: { projectId } });
};
