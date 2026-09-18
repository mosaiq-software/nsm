import { sequelize } from '@/utils/dbHelper';
import { Capability, TeamConfig, TeamType } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// Stored configuration for a team, keyed by the owner's stable GitHub account id. This row is never
// deleted when the App is uninstalled, so re-installing restores the team's default capabilities.
class TeamConfigModel extends Model {}
TeamConfigModel.init(
    {
        ownerId: { type: DataTypes.STRING, primaryKey: true },
        login: DataTypes.STRING,
        type: DataTypes.STRING,
        defaultCapabilitiesJson: DataTypes.TEXT,
    },
    { sequelize, timestamps: false }
);

interface TeamConfigRow {
    ownerId: string;
    login: string;
    type: string;
    defaultCapabilitiesJson: string;
}

const rowToConfig = (row: TeamConfigRow): TeamConfig => ({
    ownerId: row.ownerId,
    login: row.login,
    type: row.type as TeamType,
    defaultCapabilities: parseCaps(row.defaultCapabilitiesJson),
});

const parseCaps = (json: string | null | undefined): Capability[] => {
    if (!json) return [];
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? (arr as Capability[]) : [];
    } catch {
        return [];
    }
};

export const upsertTeamConfigModel = async (config: TeamConfig): Promise<void> => {
    const row: TeamConfigRow = {
        ownerId: config.ownerId,
        login: config.login,
        type: config.type,
        defaultCapabilitiesJson: JSON.stringify(config.defaultCapabilities || []),
    };
    const existing = await TeamConfigModel.findOne({ where: { ownerId: config.ownerId } });
    if (existing) {
        await existing.update(row);
        return;
    }
    await TeamConfigModel.create({ ...row });
};

export const getTeamConfigModel = async (ownerId: string): Promise<TeamConfig | null> => {
    const row = await TeamConfigModel.findOne({ where: { ownerId } });
    return row ? rowToConfig(row.toJSON() as TeamConfigRow) : null;
};

export const getTeamConfigByLoginModel = async (login: string): Promise<TeamConfig | null> => {
    const rows = await TeamConfigModel.findAll();
    const match = rows.map((r) => r.toJSON() as TeamConfigRow).find((r) => r.login.toLowerCase() === login.toLowerCase());
    return match ? rowToConfig(match) : null;
};

export const getAllTeamConfigsModel = async (): Promise<TeamConfig[]> => {
    const rows = await TeamConfigModel.findAll();
    return rows.map((r) => rowToConfig(r.toJSON() as TeamConfigRow));
};
