import { sequelize } from '@/utils/dbHelper';
import { Capability, TeamMemberOverride } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// Per-member permission override, keyed by (ownerId, memberId) using stable GitHub account ids so it
// survives a member leaving and later rejoining the org. Additive-only: unioned with the team
// default when computing effective permissions. Never deleted automatically on membership changes.
class TeamMemberOverrideModel extends Model {}
TeamMemberOverrideModel.init(
    {
        ownerId: { type: DataTypes.STRING, primaryKey: true },
        memberId: { type: DataTypes.STRING, primaryKey: true },
        memberLogin: DataTypes.STRING,
        capabilitiesJson: DataTypes.TEXT,
    },
    { sequelize, timestamps: false }
);

interface OverrideRow {
    ownerId: string;
    memberId: string;
    memberLogin: string;
    capabilitiesJson: string;
}

const parseCaps = (json: string | null | undefined): Capability[] => {
    if (!json) return [];
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? (arr as Capability[]) : [];
    } catch {
        return [];
    }
};

const rowToOverride = (row: OverrideRow): TeamMemberOverride => ({
    ownerId: row.ownerId,
    memberId: row.memberId,
    memberLogin: row.memberLogin,
    capabilities: parseCaps(row.capabilitiesJson),
});

export const upsertTeamOverrideModel = async (override: TeamMemberOverride): Promise<void> => {
    const row: OverrideRow = {
        ownerId: override.ownerId,
        memberId: override.memberId,
        memberLogin: override.memberLogin,
        capabilitiesJson: JSON.stringify(override.capabilities || []),
    };
    const existing = await TeamMemberOverrideModel.findOne({ where: { ownerId: override.ownerId, memberId: override.memberId } });
    if (existing) {
        await existing.update(row);
        return;
    }
    await TeamMemberOverrideModel.create({ ...row });
};

export const deleteTeamOverrideModel = async (ownerId: string, memberId: string): Promise<void> => {
    await TeamMemberOverrideModel.destroy({ where: { ownerId, memberId } });
};

export const getTeamOverridesForOwnerModel = async (ownerId: string): Promise<TeamMemberOverride[]> => {
    const rows = await TeamMemberOverrideModel.findAll({ where: { ownerId } });
    return rows.map((r) => rowToOverride(r.toJSON() as OverrideRow));
};

export const getTeamOverrideModel = async (ownerId: string, memberId: string): Promise<TeamMemberOverride | null> => {
    const row = await TeamMemberOverrideModel.findOne({ where: { ownerId, memberId } });
    return row ? rowToOverride(row.toJSON() as OverrideRow) : null;
};
