import { sequelize } from '@/utils/dbHelper';
import { DomainBilling } from '@mosaiq/nsm-common/types';
import { DataTypes, Model, Op } from 'sequelize';

// Leader-local cache of Cloudflare zones (domains). Cloudflare is authoritative: this table is a
// mirror refreshed by cloudflareSync and is never replicated to followers (like the cert cache).
class DnsZoneModel extends Model {}
DnsZoneModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        name: DataTypes.STRING,
        status: DataTypes.STRING,
        paused: DataTypes.BOOLEAN,
        billingJson: DataTypes.TEXT,
        recordCount: DataTypes.NUMBER,
        lastSyncedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

export interface DnsZoneCache {
    id: string;
    name: string;
    status: string;
    paused: boolean;
    billing?: DomainBilling;
    recordCount?: number;
    lastSyncedAt?: number;
}

interface DnsZoneRow {
    id: string;
    name: string;
    status: string;
    paused: boolean;
    billingJson?: string | null;
    recordCount?: number;
    lastSyncedAt?: number;
}

const rowToZone = (row: DnsZoneRow): DnsZoneCache => ({
    id: row.id,
    name: row.name,
    status: row.status,
    paused: !!row.paused,
    billing: row.billingJson ? (JSON.parse(row.billingJson) as DomainBilling) : undefined,
    recordCount: row.recordCount,
    lastSyncedAt: row.lastSyncedAt,
});

export const upsertDnsZoneModel = async (zone: DnsZoneCache): Promise<void> => {
    const row: DnsZoneRow = {
        id: zone.id,
        name: zone.name,
        status: zone.status,
        paused: zone.paused,
        billingJson: zone.billing ? JSON.stringify(zone.billing) : null,
        recordCount: zone.recordCount ?? 0,
        lastSyncedAt: zone.lastSyncedAt ?? Date.now(),
    };
    const existing = await DnsZoneModel.findByPk(zone.id);
    if (existing) await existing.update(row);
    else await DnsZoneModel.create({ ...row });
};

export const getAllDnsZonesModel = async (): Promise<DnsZoneCache[]> => {
    return (await DnsZoneModel.findAll()).map((z) => rowToZone(z.toJSON() as DnsZoneRow));
};

export const getDnsZoneModel = async (zoneId: string): Promise<DnsZoneCache | null> => {
    const row = await DnsZoneModel.findByPk(zoneId);
    return row ? rowToZone(row.toJSON() as DnsZoneRow) : null;
};

export const getDnsZoneByNameModel = async (name: string): Promise<DnsZoneCache | null> => {
    const rows = await DnsZoneModel.findAll();
    const match = rows.map((r) => r.toJSON() as DnsZoneRow).find((r) => r.name.toLowerCase() === name.toLowerCase());
    return match ? rowToZone(match) : null;
};

export const deleteDnsZoneModel = async (zoneId: string): Promise<void> => {
    await DnsZoneModel.destroy({ where: { id: zoneId } });
};

// Cloudflare-authoritative prune: drop cached zones whose ids are no longer present on Cloudflare.
export const deleteDnsZonesNotInModel = async (ids: string[]): Promise<string[]> => {
    const rows = await DnsZoneModel.findAll();
    const gone = rows.map((r) => (r.toJSON() as DnsZoneRow).id).filter((id) => !ids.includes(id));
    if (gone.length) await DnsZoneModel.destroy({ where: { id: { [Op.in]: gone } } });
    return gone;
};
