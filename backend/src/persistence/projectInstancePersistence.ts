import { sequelize } from '@/utils/dbHelper';
import { DeploymentState, ProjectInstance, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { DataTypes, Model, Op } from 'sequelize';
import { Mutex } from 'async-mutex';

const mutex = new Mutex();

export interface ProjectInstanceModelType extends ProjectInstanceHeader {
    deploymentLog: string;
}
class ProjectInstanceModel extends Model {}
ProjectInstanceModel.init(
    {
        id: {
            type: DataTypes.STRING,
            primaryKey: true,
        },
        projectId: DataTypes.STRING,
        workerNodeId: DataTypes.STRING,
        state: DataTypes.STRING,
        created: DataTypes.NUMBER,
        lastUpdated: DataTypes.NUMBER,
        deploymentLog: DataTypes.TEXT,
        active: DataTypes.BOOLEAN,
        directoriesJson: DataTypes.TEXT,
        deployStartedAt: DataTypes.NUMBER,
        deployDurationMs: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

export const getAllActiveProjectInstancesModel = async (): Promise<ProjectInstanceModelType[]> => {
    const instances = (await ProjectInstanceModel.findAll({ where: { active: true } }))?.map((sec) => sec.toJSON());
    return instances.map((instance) => {
        const directories = JSON.parse(instance.directoriesJson || '{}') as ProjectInstance['directories'];
        if (instance?.directoriesJson) {
            delete instance.directoriesJson;
        }
        return { ...instance, directories } as ProjectInstanceModelType;
    });
};
export const getProjectInstancesByProjectIdModel = async (projectId: string): Promise<ProjectInstanceModelType[]> => {
    const instances = (await ProjectInstanceModel.findAll({ where: { projectId } }))?.map((sec) => sec.toJSON());
    return instances.map((instance) => {
        const directories = JSON.parse(instance.directoriesJson || '{}') as ProjectInstance['directories'];
        if (instance?.directoriesJson) {
            delete instance.directoriesJson;
        }
        return { ...instance, directories } as ProjectInstanceModelType;
    });
};

export const getProjectInstancesByStateModel = async (state: DeploymentState): Promise<ProjectInstanceModelType[]> => {
    const instances = (await ProjectInstanceModel.findAll({ where: { state } }))?.map((sec) => sec.toJSON());
    return instances.map((instance) => {
        const directories = JSON.parse(instance.directoriesJson || '{}') as ProjectInstance['directories'];
        if (instance?.directoriesJson) {
            delete instance.directoriesJson;
        }
        return { ...instance, directories } as ProjectInstanceModelType;
    });
};

export const getProjectInstanceByIdModel = async (id: string): Promise<ProjectInstanceModelType | null> => {
    const instance = (await ProjectInstanceModel.findByPk(id))?.toJSON();
    const directories = JSON.parse(instance?.directoriesJson || '{}') as ProjectInstance['directories'];
    if (instance?.directoriesJson) {
        delete instance.directoriesJson;
    }
    return (instance ? { ...instance, directories } : null) as ProjectInstanceModelType | null;
};

export const createProjectInstanceModel = async (projectInstanceData: ProjectInstanceHeader): Promise<void> => {
    await ProjectInstanceModel.create({ ...projectInstanceData, lastUpdated: Date.now(), created: Date.now(), deploymentLog: '' });
};

export const updateProjectInstanceModel = async (id: string, projectInstanceData: Partial<ProjectInstanceHeader>): Promise<void> => {
    await ProjectInstanceModel.update({ ...projectInstanceData, lastUpdated: Date.now() }, { where: { id } });
};

export const deleteProjectInstanceModel = async (id: string) => {
    return await ProjectInstanceModel.destroy({ where: { id } });
};

// Most recent successful deploy durations (ms) for a project, newest first, capped at `limit`. Only
// DEPLOYED instances that recorded a duration are returned, so callers can average real deploy time.
export const getRecentDeployDurationsModel = async (projectId: string, limit: number): Promise<number[]> => {
    const rows = await ProjectInstanceModel.findAll({
        where: { projectId, state: DeploymentState.DEPLOYED, deployDurationMs: { [Op.ne]: null } },
        order: [['deployStartedAt', 'DESC']],
        limit,
    });
    return rows.map((r) => r.toJSON().deployDurationMs as number).filter((d) => typeof d === 'number' && d >= 0);
};

export const appendToDeploymentLog = async (id: string, log: string) => {
    await mutex.runExclusive(async () => {
        const instance = await getProjectInstanceByIdModel(id);
        if (!instance) throw new Error('Project Instance not found');
        await ProjectInstanceModel.update(
            {
                deploymentLog: `${instance.deploymentLog ?? ''}${log}`,
                lastUpdated: Date.now(),
            },
            { where: { id } }
        );
    });
};
