import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// Durable NSM-side allocation of a Cloudflare zone (domain) to a team, keyed by (zoneId, ownerId).
// A domain is usable in a team's project config only when allocated. Applied via the state machine
// (SET_DOMAIN_ALLOCATIONS).
class DomainTeamAllocationModel extends Model {}
DomainTeamAllocationModel.init(
    {
        zoneId: { type: DataTypes.STRING, primaryKey: true },
        ownerId: { type: DataTypes.STRING, primaryKey: true },
    },
    { sequelize, timestamps: false }
);

interface AllocationRow {
    zoneId: string;
    ownerId: string;
}

// Replace the full set of teams allocated to a zone.
export const setDomainAllocationsModel = async (zoneId: string, ownerIds: string[]): Promise<void> => {
    await DomainTeamAllocationModel.destroy({ where: { zoneId } });
    const unique = [...new Set(ownerIds)];
    if (unique.length) await DomainTeamAllocationModel.bulkCreate(unique.map((ownerId) => ({ zoneId, ownerId })) as any[]);
};

export const getAllocationsForZoneModel = async (zoneId: string): Promise<string[]> => {
    return (await DomainTeamAllocationModel.findAll({ where: { zoneId } })).map((r) => (r.toJSON() as AllocationRow).ownerId);
};

export const getAllDomainAllocationsModel = async (): Promise<AllocationRow[]> => {
    return (await DomainTeamAllocationModel.findAll()).map((r) => r.toJSON() as AllocationRow);
};

export const getZonesForOwnerModel = async (ownerId: string): Promise<string[]> => {
    return (await DomainTeamAllocationModel.findAll({ where: { ownerId } })).map((r) => (r.toJSON() as AllocationRow).zoneId);
};

export const deleteAllocationsForZoneModel = async (zoneId: string): Promise<void> => {
    await DomainTeamAllocationModel.destroy({ where: { zoneId } });
};
