import { sequelize } from '@/utils/dbHelper';
import { ApiKey, ApiKeyPermission } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// A project-scoped API key. Durable, user-authored data replicated via cluster ops. Only a SHA-256
// hash of the secret is stored (never the plaintext); the short prefix is for display only.
class ApiKeyModel extends Model {}
ApiKeyModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        name: DataTypes.STRING,
        prefix: DataTypes.STRING,
        hashedKey: DataTypes.STRING,
        permissionsJson: DataTypes.TEXT,
        createdBy: DataTypes.STRING,
        createdAt: DataTypes.NUMBER,
        lastUsedAt: DataTypes.NUMBER,
        revokedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toApiKey = (row: any): ApiKey => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prefix: row.prefix,
    hashedKey: row.hashedKey,
    permissions: JSON.parse(row.permissionsJson || '[]') as ApiKeyPermission[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
});

const toRow = (apiKey: ApiKey) => ({
    id: apiKey.id,
    projectId: apiKey.projectId,
    name: apiKey.name,
    prefix: apiKey.prefix,
    hashedKey: apiKey.hashedKey,
    permissionsJson: JSON.stringify(apiKey.permissions || []),
    createdBy: apiKey.createdBy,
    createdAt: apiKey.createdAt,
    lastUsedAt: apiKey.lastUsedAt,
    revokedAt: apiKey.revokedAt,
});

export const upsertApiKeyModel = async (apiKey: ApiKey): Promise<void> => {
    const existing = await ApiKeyModel.findByPk(apiKey.id);
    if (existing) {
        await existing.update(toRow(apiKey));
    } else {
        await ApiKeyModel.create(toRow(apiKey));
    }
};

export const getApiKeyByIdModel = async (id: string): Promise<ApiKey | null> => {
    const row = await ApiKeyModel.findByPk(id);
    return row ? toApiKey(row.toJSON()) : null;
};

export const getApiKeyByHashModel = async (hashedKey: string): Promise<ApiKey | null> => {
    const row = await ApiKeyModel.findOne({ where: { hashedKey } });
    return row ? toApiKey(row.toJSON()) : null;
};

export const getApiKeysByProjectModel = async (projectId: string): Promise<ApiKey[]> => {
    const rows = await ApiKeyModel.findAll({ where: { projectId } });
    return rows.map((r) => toApiKey(r.toJSON())).sort((a, b) => b.createdAt - a.createdAt);
};

export const revokeApiKeyModel = async (id: string, revokedAt: number): Promise<void> => {
    await ApiKeyModel.update({ revokedAt }, { where: { id } });
};

// Metadata-only update of the last-used timestamp. Written directly (not via an op) to avoid
// replicating a write on every authenticated API request.
export const touchApiKeyModel = async (id: string, lastUsedAt: number): Promise<void> => {
    await ApiKeyModel.update({ lastUsedAt }, { where: { id } });
};

export const deleteApiKeysForProjectModel = async (projectId: string): Promise<void> => {
    await ApiKeyModel.destroy({ where: { projectId } });
};
