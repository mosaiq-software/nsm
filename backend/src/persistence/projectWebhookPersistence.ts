import { sequelize } from '@/utils/dbHelper';
import { GithubScenarioConfig, ProjectEventType, ProjectWebhook, ProjectWebhookType } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// An outbound webhook configured on a project. Durable, user-authored config replicated via cluster
// ops (like incidents), so it survives and is served from the leader's source-of-truth DB. The
// subscribed events are stored as a JSON array string.
class ProjectWebhookModel extends Model {}
ProjectWebhookModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        type: DataTypes.STRING,
        name: DataTypes.TEXT,
        url: DataTypes.TEXT,
        eventsJson: DataTypes.TEXT,
        githubScenariosJson: DataTypes.TEXT,
        enabled: DataTypes.BOOLEAN,
        createdBy: DataTypes.STRING,
        createdAt: DataTypes.NUMBER,
        updatedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toWebhook = (row: any): ProjectWebhook => ({
    id: row.id,
    projectId: row.projectId,
    type: row.type as ProjectWebhookType,
    name: row.name,
    url: row.url,
    events: JSON.parse(row.eventsJson || '[]') as ProjectEventType[],
    githubScenarios: JSON.parse(row.githubScenariosJson || '[]') as GithubScenarioConfig[],
    enabled: !!row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const toRow = (webhook: ProjectWebhook) => ({
    id: webhook.id,
    projectId: webhook.projectId,
    type: webhook.type,
    name: webhook.name,
    url: webhook.url,
    eventsJson: JSON.stringify(webhook.events || []),
    githubScenariosJson: JSON.stringify(webhook.githubScenarios || []),
    enabled: webhook.enabled,
    createdBy: webhook.createdBy,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
});

export const upsertProjectWebhookModel = async (webhook: ProjectWebhook): Promise<void> => {
    const existing = await ProjectWebhookModel.findByPk(webhook.id);
    if (existing) {
        await existing.update(toRow(webhook));
    } else {
        await ProjectWebhookModel.create(toRow(webhook));
    }
};

export const getProjectWebhookByIdModel = async (id: string): Promise<ProjectWebhook | null> => {
    const row = await ProjectWebhookModel.findByPk(id);
    return row ? toWebhook(row.toJSON()) : null;
};

export const getWebhooksByProjectModel = async (projectId: string): Promise<ProjectWebhook[]> => {
    const rows = await ProjectWebhookModel.findAll({ where: { projectId } });
    return rows.map((r) => toWebhook(r.toJSON())).sort((a, b) => a.createdAt - b.createdAt);
};

export const deleteProjectWebhookModel = async (id: string): Promise<void> => {
    await ProjectWebhookModel.destroy({ where: { id } });
};

export const deleteWebhooksForProjectModel = async (projectId: string): Promise<void> => {
    await ProjectWebhookModel.destroy({ where: { projectId } });
};
