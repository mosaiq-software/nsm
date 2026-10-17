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
        registrarAccountId: { type: DataTypes.STRING, allowNull: true },
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
    registrarAccountId?: string;
    recordCount?: number;
    lastSyncedAt?: number;
}

interface DnsZoneRow {
    id: string;
    name: string;
    status: string;
    paused: boolean;
    billingJson?: string | null;
    registrarAccountId?: string | null;
    recordCount?: number;
    lastSyncedAt?: number;
}

const rowToZone = (row: DnsZoneRow): DnsZoneCache => ({
    id: row.id,
    name: row.name,
    status: row.status,
    paused: !!row.paused,
    billing: row.billingJson ? (JSON.parse(row.billingJson) as DomainBilling) : undefined,
    registrarAccountId: row.registrarAccountId ?? undefined,
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
        registrarAccountId: zone.registrarAccountId ?? null,
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

export const getDnsZonesForAccountModel = async (registrarAccountId: string): Promise<DnsZoneCache[]> => {
    return (await DnsZoneModel.findAll({ where: { registrarAccountId } })).map((z) => rowToZone(z.toJSON() as DnsZoneRow));
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

// Cloudflare-authoritative prune, scoped to a single registrar account: drop that account's cached
// zones whose ids are no longer present on Cloudflare. Scoping by account is required so syncing one
// account never prunes another account's zones that share the cache.
export const deleteDnsZonesNotInModelForAccount = async (registrarAccountId: string, ids: string[]): Promise<string[]> => {
    const rows = await DnsZoneModel.findAll({ where: { registrarAccountId } });
    const gone = rows.map((r) => (r.toJSON() as DnsZoneRow).id).filter((id) => !ids.includes(id));
    if (gone.length) await DnsZoneModel.destroy({ where: { id: { [Op.in]: gone } } });
    return gone;
};
