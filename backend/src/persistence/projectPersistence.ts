import { sequelize } from '@/utils/dbHelper';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';
export interface ProjectModelType {
    id: string;
    state: DeploymentState;
    repoOwner: string;
    repoName: string;
    repoBranch?: string;
    deploymentKey: string;
    allowCICD: boolean;
    timeout?: number;
    dirtyConfig?: boolean;
    nginxConfigJson: string;
    dockerComposeJson: string;
    servicesJson: string;
    workerNodeId?: string;
    hasDockerCompose?: boolean;
    hasDotenv?: boolean;
    zeroDowntime?: boolean;
    createdAt?: string;
    updatedAt?: string;
}
class ProjectModel extends Model {}
ProjectModel.init(
    {
        id: {
            type: DataTypes.STRING,
            primaryKey: true,
        },
        state: DataTypes.STRING,
        repoOwner: DataTypes.STRING,
        repoName: DataTypes.STRING,
        repoBranch: DataTypes.STRING,
        deploymentKey: DataTypes.STRING,
        allowCICD: DataTypes.BOOLEAN,
        timeout: DataTypes.NUMBER,
        dirtyConfig: DataTypes.BOOLEAN,
        nginxConfigJson: DataTypes.TEXT,
        dockerComposeJson: DataTypes.TEXT,
        servicesJson: DataTypes.TEXT,
        workerNodeId: DataTypes.STRING,
        hasDockerCompose: DataTypes.BOOLEAN,
        hasDotenv: DataTypes.BOOLEAN,
        zeroDowntime: DataTypes.BOOLEAN,
    },
    { sequelize }
);

export const getProjectByIdModel = async (id: string) => {
    return (await ProjectModel.findByPk(id))?.toJSON() as ProjectModelType | undefined;
};

export const getAllProjectsModel = async (): Promise<ProjectModelType[]> => {
    return (await ProjectModel.findAll())?.map((project) => project.toJSON()) as ProjectModelType[];
};

export const createProjectModel = async (id: string, data: Partial<ProjectModelType>) => {
    return await ProjectModel.create({ id, ...data });
};

export const updateProjectModelNoDirty = async (id: string, data: Partial<ProjectModelType>) => {
    return await ProjectModel.update(
        {
            ...data,
        },
        { where: { id } }
    );
};

export const deleteProjectModel = async (id: string) => {
    return await ProjectModel.destroy({ where: { id } });
};

// Create-or-replace a project row. Used by the state machine when applying UPSERT_PROJECT.
export const upsertProjectModel = async (row: ProjectModelType) => {
    const existing = await ProjectModel.findByPk(row.id);
    if (existing) {
        await existing.update({ ...row });
    } else {
        await ProjectModel.create({ ...row });
    }
};
