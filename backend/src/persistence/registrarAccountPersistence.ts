import { sequelize } from '@/utils/dbHelper';
import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { RegistrarProvider } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// A registrar account (e.g. a Cloudflare account) keyed by a stable shared id so multiple teams can
// point at the same account. `credentialsJson` holds secret values (API tokens) and is replicated
// across the cluster like project secrets so the leader can use it after a failover. Credentials
// are never serialized into API responses - only a secret-free summary is exposed to the UI.
class RegistrarAccountModel extends Model {}
RegistrarAccountModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        provider: DataTypes.STRING,
        label: { type: DataTypes.STRING, allowNull: true },
        credentialsJson: DataTypes.TEXT,
        createdAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

interface RegistrarAccountRow {
    id: string;
    provider: string;
    label?: string | null;
    credentialsJson?: string | null;
    createdAt?: number;
}

const parseCreds = (json: string | null | undefined): Record<string, string> => {
    if (!json) return {};
    try {
        const obj = JSON.parse(json);
        return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
    } catch {
        // Corrupt credentials JSON is treated as unconfigured rather than crashing callers.
        return {};
    }
};

const rowToAccount = (row: RegistrarAccountRow): RegistrarAccountRecord => ({
    id: row.id,
    provider: row.provider as RegistrarProvider,
    label: row.label ?? undefined,
    credentials: parseCreds(row.credentialsJson),
    createdAt: row.createdAt ?? 0,
});

export const upsertRegistrarAccountModel = async (account: RegistrarAccountRecord): Promise<void> => {
    const row: RegistrarAccountRow = {
        id: account.id,
        provider: account.provider,
        label: account.label ?? null,
        credentialsJson: JSON.stringify(account.credentials || {}),
        createdAt: account.createdAt ?? Date.now(),
    };
    const existing = await RegistrarAccountModel.findByPk(account.id);
    if (existing) await existing.update(row);
    else await RegistrarAccountModel.create({ ...row });
};

export const getRegistrarAccountModel = async (id: string): Promise<RegistrarAccountRecord | null> => {
    const row = await RegistrarAccountModel.findByPk(id);
    return row ? rowToAccount(row.toJSON() as RegistrarAccountRow) : null;
};

export const getAllRegistrarAccountsModel = async (): Promise<RegistrarAccountRecord[]> => {
    return (await RegistrarAccountModel.findAll()).map((r) => rowToAccount(r.toJSON() as RegistrarAccountRow));
};

export const deleteRegistrarAccountModel = async (id: string): Promise<void> => {
    await RegistrarAccountModel.destroy({ where: { id } });
};
