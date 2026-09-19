import { sequelize } from '@/utils/dbHelper';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';
export interface ProjectModelType {
    id: string;
    state: DeploymentState;
    repoOwner: string;
    repoName: string;
    repoBranch?: string;
    // SHA-256 hex of the deploy key. The raw key is only ever shown once (create/rotate).
    deploymentKeyHash: string;
    // JSON of the shared GitHub webhook ref ({ hookId, tokenHash }) or '' when unprovisioned.
    githubWebhookJson: string;
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
    cicdConfigJson: string;
    resourceQuotaJson: string;
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
        deploymentKeyHash: DataTypes.STRING,
        githubWebhookJson: DataTypes.TEXT,
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
        cicdConfigJson: DataTypes.TEXT,
        resourceQuotaJson: DataTypes.TEXT,
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
