import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// Simple key/value table for singleton cluster metadata (e.g. desired NSM version).
class ClusterMetaModel extends Model {}
ClusterMetaModel.init(
    {
        key: { type: DataTypes.STRING, primaryKey: true },
        value: DataTypes.TEXT,
    },
    { sequelize, timestamps: false }
);

export const getMeta = async (key: string): Promise<string | null> => {
    const row = await ClusterMetaModel.findByPk(key);
    return (row?.toJSON() as any)?.value ?? null;
};

export const setMeta = async (key: string, value: string): Promise<void> => {
    const existing = await ClusterMetaModel.findByPk(key);
    if (existing) {
        await existing.update({ value });
    } else {
        await ClusterMetaModel.create({ key, value });
    }
};

export const getDesiredNsmVersion = async (): Promise<{ version: string; artifactRef: string } | null> => {
    const v = await getMeta('desiredNsmVersion');
    return v ? (JSON.parse(v) as { version: string; artifactRef: string }) : null;
};

export const setDesiredNsmVersion = async (version: string, artifactRef: string): Promise<void> => {
    await setMeta('desiredNsmVersion', JSON.stringify({ version, artifactRef }));
};
