import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// Link from a team (keyed by GitHub owner id) to the registrar account it uses. Kept in a dedicated
// table (rather than on TeamConfig) so user-type teams - which have no TeamConfig row - can
// configure a registrar, and so the registrar concern stays separate from capability defaults.
class TeamRegistrarModel extends Model {}
TeamRegistrarModel.init(
    {
        ownerId: { type: DataTypes.STRING, primaryKey: true },
        registrarAccountId: DataTypes.STRING,
    },
    { sequelize, timestamps: false }
);

interface TeamRegistrarRow {
    ownerId: string;
    registrarAccountId: string;
}

export const setTeamRegistrarModel = async (ownerId: string, registrarAccountId: string | null): Promise<void> => {
    if (!registrarAccountId) {
        await TeamRegistrarModel.destroy({ where: { ownerId } });
        return;
    }
    const existing = await TeamRegistrarModel.findByPk(ownerId);
    if (existing) await existing.update({ registrarAccountId });
    else await TeamRegistrarModel.create({ ownerId, registrarAccountId });
};

export const getTeamRegistrarModel = async (ownerId: string): Promise<string | null> => {
    const row = await TeamRegistrarModel.findByPk(ownerId);
    return row ? (row.toJSON() as TeamRegistrarRow).registrarAccountId : null;
};

// Team owner ids pointing at a given registrar account (used to decide whether an account is still
// referenced before deleting it).
export const getTeamsForRegistrarAccountModel = async (registrarAccountId: string): Promise<string[]> => {
    const rows = await TeamRegistrarModel.findAll({ where: { registrarAccountId } });
    return rows.map((r) => (r.toJSON() as TeamRegistrarRow).ownerId);
};
