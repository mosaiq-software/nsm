import { sequelize } from '@/utils/dbHelper';
import { DiscordMessageRef, GithubScenario } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// Tracks Discord messages NSM created for GitHub subjects (a specific PR/issue/run), so later
// sub-events can edit or delete them. Durable and replicated via cluster ops, keyed by
// (webhookId, scenario, externalKey). Created by sequelize.sync() / migration 0009.
class DiscordMessageRefModel extends Model {}
DiscordMessageRefModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        webhookId: DataTypes.STRING,
        scenario: DataTypes.STRING,
        externalKey: DataTypes.STRING,
        channelMessageId: DataTypes.STRING,
        createdAt: DataTypes.NUMBER,
        updatedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toRef = (row: any): DiscordMessageRef => ({
    id: row.id,
    projectId: row.projectId,
    webhookId: row.webhookId,
    scenario: row.scenario as GithubScenario,
    externalKey: row.externalKey,
    channelMessageId: row.channelMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

export const upsertDiscordMessageRefModel = async (ref: DiscordMessageRef): Promise<void> => {
    const existing = await DiscordMessageRefModel.findByPk(ref.id);
    if (existing) {
        await existing.update({ ...ref });
    } else {
        await DiscordMessageRefModel.create({ ...ref });
    }
};

export const deleteDiscordMessageRefModel = async (id: string): Promise<void> => {
    await DiscordMessageRefModel.destroy({ where: { id } });
};

export const getDiscordMessageRefByKeyModel = async (webhookId: string, scenario: GithubScenario, externalKey: string): Promise<DiscordMessageRef | null> => {
    const row = await DiscordMessageRefModel.findOne({ where: { webhookId, scenario, externalKey } });
    return row ? toRef(row.toJSON()) : null;
};

export const deleteDiscordMessageRefsForWebhookModel = async (webhookId: string): Promise<void> => {
    await DiscordMessageRefModel.destroy({ where: { webhookId } });
};

export const deleteDiscordMessageRefsForProjectModel = async (projectId: string): Promise<void> => {
    await DiscordMessageRefModel.destroy({ where: { projectId } });
};
