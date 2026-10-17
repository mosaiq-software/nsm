import { DnsRecord, DnsZone, DnsZoneAnalytics, DNS_STRUCTURED_TYPES } from '@mosaiq/nsm-common/types';
import { getDnsZonesForAccountModel, getDnsZoneModel, DnsZoneCache } from '@/persistence/dnsZonePersistence';
import { getRecordsByPortReservationModel, getRecordsForZoneModel } from '@/persistence/dnsRecordPersistence';
import { getPortReservationByIdModel } from '@/persistence/portReservationPersistence';
import { addDynamicTag, removeDynamicTag, removePortTag, setPortTag } from '@/utils/dnsTags';
import { DnsProvider, DnsWriteInput } from '@/registrar/provider';
import { syncZoneRecords } from '@/reconcile/cloudflareSync';
import { getProviderForTeam, getProviderForZone } from '@/controllers/registrarController';
import { checkPublicIp, getKnownPublicIp } from '@/reconcile/publicIpWatcher';
import { areaLog, serializeError } from '@/utils/log';

// Record types that carry a port NSM can drive from a reservation. SRV's port lives in `data.port`.
const PORT_BINDABLE_TYPES = new Set(['SRV']);

const dnsLog = areaLog('dns');

type ZoneRef = { id: string; name: string };

// Proxying (orange cloud) is only meaningful on these record types.
const PROXYABLE_TYPES = new Set(['A', 'AAAA', 'CNAME']);

// Project a cached zone into the shared DnsZone view. `dashboardUrl` is the registrar's management
// link for the zone (provider-specific), when available.
export const buildZoneView = (zone: DnsZoneCache, dashboardUrl?: string): DnsZone => ({
    id: zone.id,
    name: zone.name,
    status: zone.status,
    paused: zone.paused,
    billing: zone.billing,
    registrarAccountId: zone.registrarAccountId,
    recordCount: zone.recordCount,
    lastSyncedAt: zone.lastSyncedAt,
    dashboardUrl,
});

// All zones for the team's registrar account. Teams sharing an account see the same zones.
export const listTeamDomains = async (ownerId: string): Promise<DnsZone[]> => {
    const resolved = await getProviderForTeam(ownerId);
    if (!resolved) return [];
    const zones = await getDnsZonesForAccountModel(resolved.account.id);
    return zones.map((z) => buildZoneView(z, resolved.provider.dashboardUrl(z.name))).sort((a, b) => a.name.localeCompare(b.name));
};

export const listRecords = async (zoneId: string): Promise<DnsRecord[]> => {
    return (await getRecordsForZoneModel(zoneId)).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
};

// Normalize a DNS name for matching analytics query names to records: lowercase, no trailing dot.
const normalizeDnsName = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

// UTC date string (YYYY-MM-DD) offset by `deltaDays` from today.
const dayString = (deltaDays: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
};

const ANALYTICS_WINDOW_DAYS = 7;

// Past-week DNS query traffic for a zone, aggregated per query name plus a zone-wide total. Traffic
// is attributed to records by name (summed across query types). Returns an empty window if the
// Cloudflare token lacks analytics access so the UI degrades gracefully.
export const getZoneAnalytics = async (provider: DnsProvider, zoneId: string): Promise<DnsZoneAnalytics> => {
    const days: string[] = [];
    for (let i = ANALYTICS_WINDOW_DAYS - 1; i >= 0; i--) days.push(dayString(-i));
    const since = days[0];
    const until = days[days.length - 1];

    const empty: DnsZoneAnalytics = { since, until, days, total: 0, totalSeries: days.map((date) => ({ date, count: 0 })), byName: [] };

    let rows;
    try {
        rows = await provider.getAnalytics(zoneId, since, until);
    } catch (e: any) {
        dnsLog.warn({ action: 'dns_analytics_failed', zoneId, err: serializeError(e) }, `failed to load DNS analytics for zone ${zoneId}`);
        return empty;
    }

    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const byNameCounts = new Map<string, number[]>();
    const totalPerDay = new Array(days.length).fill(0);
    let total = 0;

    for (const row of rows) {
        const idx = dayIndex.get(row.date);
        if (idx === undefined) continue;
        const name = normalizeDnsName(row.queryName);
        if (!name) continue;
        const series = byNameCounts.get(name) ?? new Array(days.length).fill(0);
        series[idx] += row.count;
        byNameCounts.set(name, series);
        totalPerDay[idx] += row.count;
        total += row.count;
    }

    const byName = [...byNameCounts.entries()]
        .map(([name, counts]) => ({
            name,
            total: counts.reduce((a, b) => a + b, 0),
            series: days.map((date, i) => ({ date, count: counts[i] })),
        }))
        .sort((a, b) => b.total - a.total);

    return { since, until, days, total, totalSeries: days.map((date, i) => ({ date, count: totalPerDay[i] })), byName };
};

// Build the provider-neutral create/update body from a partial DnsRecord, honoring the dynamic-IP
// toggle: dynamic records get the marker written into their comment, and (for A/AAAA) their content
// set to the currently-detected public IP. The resolved provider maps this to its own API shape.
const buildRecordInput = async (input: Partial<DnsRecord>, existing?: DnsRecord): Promise<DnsWriteInput> => {
    const type = (input.type || existing?.type)!;
    const name = (input.name ?? existing?.name)!;
    const dynamic = input.dynamic ?? existing?.dynamic ?? false;

    const body: DnsWriteInput = { type, name, ttl: input.ttl ?? existing?.ttl ?? 1 };

    const isStructured = DNS_STRUCTURED_TYPES.includes(type as any);
    if (isStructured && (input.data || existing?.data)) {
        body.data = (input.data ?? existing?.data) as Record<string, unknown>;
    } else {
        body.content = input.content ?? existing?.content ?? '';
    }

    if (PROXYABLE_TYPES.has(type)) {
        const proxied = input.proxied ?? existing?.proxied ?? false;
        body.proxied = proxied;
    }
    const priority = input.priority ?? existing?.priority;
    if (priority !== undefined) body.priority = priority;

    // Port reservation binding: when explicitly provided use it, otherwise keep the existing binding.
    // An empty value clears the binding.
    const rawPortRes = input.portReservationId !== undefined ? input.portReservationId : existing?.portReservationId;
    const portReservationId = rawPortRes && rawPortRes.trim() ? rawPortRes.trim() : undefined;

    // Dynamic-IP: tag the comment and pin A/AAAA content to the detected public IP.
    let comment = input.comment ?? existing?.comment ?? '';
    if (dynamic) {
        comment = addDynamicTag(comment);
        if (type === 'A' || type === 'AAAA') {
            const ip = await getKnownPublicIp();
            if (ip && type === 'A') body.content = ip;
        }
    } else {
        comment = removeDynamicTag(comment);
    }

    // Port variable: tag the comment and write the reservation's port into the record (SRV data.port).
    if (portReservationId) {
        if (!PORT_BINDABLE_TYPES.has(type)) throw new Error(`Port binding is not supported for ${type} records`);
        const reservation = await getPortReservationByIdModel(portReservationId);
        if (!reservation) throw new Error('Port reservation not found');
        const data = { ...((body.data as Record<string, unknown>) || {}), port: reservation.port };
        body.data = data;
        comment = setPortTag(comment, portReservationId);
    } else {
        comment = removePortTag(comment);
    }

    body.comment = comment || undefined;
    return body;
};

const readBack = async (zoneId: string, recordId: string): Promise<DnsRecord | undefined> => {
    await syncZoneRecords(zoneId);
    return (await getRecordsForZoneModel(zoneId)).find((r) => r.id === recordId);
};

export const createRecord = async (provider: DnsProvider, zone: ZoneRef, input: Partial<DnsRecord>): Promise<DnsRecord | undefined> => {
    if (!input.type || !input.name) throw new Error('type and name are required');
    const body = await buildRecordInput(input);
    const created = await provider.createRecord(zone, body);
    dnsLog.info({ action: 'record_created', zoneId: zone.id, recordId: created.id, type: body.type, name: body.name }, `created ${body.type} record ${body.name}`);
    return readBack(zone.id, created.id);
};

export const updateRecord = async (provider: DnsProvider, zone: ZoneRef, recordId: string, input: Partial<DnsRecord>): Promise<DnsRecord | undefined> => {
    const existing = (await getRecordsForZoneModel(zone.id)).find((r) => r.id === recordId);
    if (!existing) throw new Error('record not found');
    const body = await buildRecordInput(input, existing);
    await provider.updateRecord(zone, recordId, body);
    dnsLog.info({ action: 'record_updated', zoneId: zone.id, recordId, type: body.type, name: body.name }, `updated record ${body.name}`);
    return readBack(zone.id, recordId);
};

export const deleteRecord = async (provider: DnsProvider, zone: ZoneRef, recordId: string): Promise<void> => {
    await provider.deleteRecord(zone, recordId);
    await syncZoneRecords(zone.id);
    dnsLog.info({ action: 'record_deleted', zoneId: zone.id, recordId }, `deleted record ${recordId}`);
};

// Repush every DNS record bound to a port reservation so its port (SRV data.port) reflects the
// reservation's current value. Called after a reservation is created/updated/deleted. When the
// reservation no longer exists the binding is stripped from the record, keeping the last port value.
export const syncPortBoundRecords = async (reservationId: string): Promise<void> => {
    const records = await getRecordsByPortReservationModel(reservationId);
    if (!records.length) return;
    const reservation = await getPortReservationByIdModel(reservationId);
    const touchedZones = new Set<string>();
    // The provider + zone are resolved per zone (via the zone's registrar account); cache per zone.
    const zoneHandles = new Map<string, { provider: DnsProvider; zone: ZoneRef } | null>();
    for (const rec of records) {
        try {
            if (!zoneHandles.has(rec.zoneId)) {
                const resolved = await getProviderForZone(rec.zoneId);
                const zone = await getDnsZoneModel(rec.zoneId);
                zoneHandles.set(rec.zoneId, resolved && zone ? { provider: resolved.provider, zone: { id: zone.id, name: zone.name } } : null);
            }
            const handle = zoneHandles.get(rec.zoneId);
            if (!handle || !handle.provider.hasRemoteConfig()) {
                dnsLog.warn({ action: 'port_record_no_creds', recordId: rec.id, zoneId: rec.zoneId }, `no registrar credentials for zone ${rec.zoneId}; skipping port-bound record`);
                continue;
            }
            if (reservation) {
                const data = { ...(rec.data || {}), port: reservation.port };
                await handle.provider.updateRecord(handle.zone, rec.id, { type: rec.type, name: rec.name, data, comment: setPortTag(rec.comment, reservationId) });
                dnsLog.info({ action: 'port_record_updated', recordId: rec.id, name: rec.name, type: rec.type, port: reservation.port }, `updated port-bound ${rec.type} ${rec.name} -> port ${reservation.port}`);
            } else {
                await handle.provider.updateRecord(handle.zone, rec.id, { comment: removePortTag(rec.comment) || undefined });
                dnsLog.warn({ action: 'port_record_unbound', recordId: rec.id, name: rec.name, reservationId }, `reservation ${reservationId} gone; stripped port binding from ${rec.name}`);
            }
            touchedZones.add(rec.zoneId);
        } catch (e: any) {
            dnsLog.error({ action: 'port_record_update_failed', recordId: rec.id, err: serializeError(e) }, `failed to update port-bound record ${rec.name}`);
        }
    }
    for (const zoneId of touchedZones) await syncZoneRecords(zoneId);
};

export const getPublicIp = async (): Promise<{ ip: string | null }> => ({ ip: await getKnownPublicIp() });

// On-demand: run the public-IP watcher now, repushing dynamic records if the WAN IP changed.
export const refreshPublicIp = async (): Promise<{ ip: string | null; changed: boolean }> => checkPublicIp();
