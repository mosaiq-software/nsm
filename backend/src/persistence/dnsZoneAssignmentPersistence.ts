import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// Durable NSM-side link from a Cloudflare zone (domain) to a project. Applied via the state machine
// (SET_ZONE_ASSIGNMENT). A zone is assigned to at most one project.
class DnsZoneAssignmentModel extends Model {}
DnsZoneAssignmentModel.init(
    {
        zoneId: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
    },
    { sequelize, timestamps: false }
);

interface AssignmentRow {
    zoneId: string;
    projectId: string;
}

export const setZoneAssignmentModel = async (zoneId: string, projectId: string | null): Promise<void> => {
    if (!projectId) {
        await DnsZoneAssignmentModel.destroy({ where: { zoneId } });
        return;
    }
    const existing = await DnsZoneAssignmentModel.findByPk(zoneId);
    if (existing) await existing.update({ projectId });
    else await DnsZoneAssignmentModel.create({ zoneId, projectId });
};

export const getZoneAssignmentModel = async (zoneId: string): Promise<string | null> => {
    const row = await DnsZoneAssignmentModel.findByPk(zoneId);
    return row ? ((row.toJSON() as AssignmentRow).projectId ?? null) : null;
};

export const getAllZoneAssignmentsModel = async (): Promise<AssignmentRow[]> => {
    return (await DnsZoneAssignmentModel.findAll()).map((r) => r.toJSON() as AssignmentRow);
};

export const deleteZoneAssignmentModel = async (zoneId: string): Promise<void> => {
    await DnsZoneAssignmentModel.destroy({ where: { zoneId } });
};
