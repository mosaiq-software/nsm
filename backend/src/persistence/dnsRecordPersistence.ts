import { sequelize } from '@/utils/dbHelper';
import { DnsRecord, DnsRecordType } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// Leader-local cache of Cloudflare DNS records, refreshed per-zone by cloudflareSync. Cloudflare is
// authoritative; this mirror powers the UI and lets the public-IP watcher find dynamic records
// without a full scan.
class DnsRecordModel extends Model {}
DnsRecordModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        zoneId: DataTypes.STRING,
        type: DataTypes.STRING,
        name: DataTypes.STRING,
        content: DataTypes.TEXT,
        proxied: DataTypes.BOOLEAN,
        ttl: DataTypes.NUMBER,
        priority: DataTypes.NUMBER,
        dataJson: DataTypes.TEXT,
        comment: DataTypes.TEXT,
        dynamic: DataTypes.BOOLEAN,
        portReservationId: DataTypes.STRING,
        lastSyncedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

interface DnsRecordRow {
    id: string;
    zoneId: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl: number;
    priority?: number;
    dataJson?: string | null;
    comment?: string | null;
    dynamic?: boolean;
    portReservationId?: string | null;
    lastSyncedAt?: number;
}

const rowToRecord = (row: DnsRecordRow): DnsRecord => ({
    id: row.id,
    zoneId: row.zoneId,
    type: row.type as DnsRecordType,
    name: row.name,
    content: row.content,
    proxied: row.proxied ?? undefined,
    ttl: row.ttl,
    priority: row.priority ?? undefined,
    data: row.dataJson ? (JSON.parse(row.dataJson) as Record<string, unknown>) : undefined,
    comment: row.comment ?? undefined,
    dynamic: !!row.dynamic,
    portReservationId: row.portReservationId ?? undefined,
});

const recordToRow = (r: DnsRecord): DnsRecordRow => ({
    id: r.id,
    zoneId: r.zoneId,
    type: r.type,
    name: r.name,
    content: r.content,
    proxied: r.proxied ?? false,
    ttl: r.ttl,
    priority: r.priority,
    dataJson: r.data ? JSON.stringify(r.data) : null,
    comment: r.comment ?? null,
    dynamic: !!r.dynamic,
    portReservationId: r.portReservationId ?? null,
    lastSyncedAt: Date.now(),
});

// Cloudflare-authoritative snapshot for a zone: replace the cached record set wholesale. Records are
// forced under the given zoneId (Cloudflare no longer returns zone_id per record). Incoming ids are
// also cleared first so any rows previously cached under a stale/empty zoneId cannot collide on the
// primary key.
export const replaceZoneRecordsModel = async (zoneId: string, records: DnsRecord[]): Promise<void> => {
    const rows = records.map((r) => recordToRow({ ...r, zoneId }));
    await DnsRecordModel.destroy({ where: { zoneId } });
    if (rows.length) {
        await DnsRecordModel.destroy({ where: { id: rows.map((r) => r.id) } });
        await DnsRecordModel.bulkCreate(rows as any[]);
    }
};

export const getRecordsForZoneModel = async (zoneId: string): Promise<DnsRecord[]> => {
    return (await DnsRecordModel.findAll({ where: { zoneId } })).map((r) => rowToRecord(r.toJSON() as DnsRecordRow));
};

export const getAllDynamicRecordsModel = async (): Promise<DnsRecord[]> => {
    return (await DnsRecordModel.findAll({ where: { dynamic: true } })).map((r) => rowToRecord(r.toJSON() as DnsRecordRow));
};

export const getRecordsByPortReservationModel = async (reservationId: string): Promise<DnsRecord[]> => {
    return (await DnsRecordModel.findAll({ where: { portReservationId: reservationId } })).map((r) => rowToRecord(r.toJSON() as DnsRecordRow));
};

export const deleteRecordsForZoneModel = async (zoneId: string): Promise<void> => {
    await DnsRecordModel.destroy({ where: { zoneId } });
};
