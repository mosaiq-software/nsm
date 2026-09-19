import { DnsRecord, DnsZone, DNS_STRUCTURED_TYPES } from '@mosaiq/nsm-common/types';
import { getAllDnsZonesModel, getDnsZoneModel, DnsZoneCache } from '@/persistence/dnsZonePersistence';
import { getRecordsByPortReservationModel, getRecordsForZoneModel } from '@/persistence/dnsRecordPersistence';
import { getAllZoneAssignmentsModel, getZoneAssignmentModel } from '@/persistence/dnsZoneAssignmentPersistence';
import { getAllocationsForZoneModel, getAllDomainAllocationsModel } from '@/persistence/domainTeamAllocationPersistence';
import { getPortReservationByIdModel } from '@/persistence/portReservationPersistence';
import { CfDnsRecordInput, addDynamicTag, createDnsRecord, deleteDnsRecord, removeDynamicTag, removePortTag, setPortTag, updateDnsRecord } from '@/utils/cloudflare';
import { syncZoneRecords } from '@/reconcile/cloudflareSync';
import { checkPublicIp, getKnownPublicIp } from '@/reconcile/publicIpWatcher';
import { areaLog } from '@/utils/log';

// Record types that carry a port NSM can drive from a reservation. SRV's port lives in `data.port`.
const PORT_BINDABLE_TYPES = new Set(['SRV']);

const dnsLog = areaLog('cloudflare');

// Proxying (orange cloud) is only meaningful on these record types.
const PROXYABLE_TYPES = new Set(['A', 'AAAA', 'CNAME']);

// Merge a cached zone with its durable NSM associations into the shared DnsZone view.
export const buildZoneView = async (zone: DnsZoneCache): Promise<DnsZone> => {
    const assignedProjectId = await getZoneAssignmentModel(zone.id);
    const allocatedTeamIds = await getAllocationsForZoneModel(zone.id);
    return {
        id: zone.id,
        name: zone.name,
        status: zone.status,
        paused: zone.paused,
        billing: zone.billing,
        recordCount: zone.recordCount,
        lastSyncedAt: zone.lastSyncedAt,
        assignedProjectId: assignedProjectId ?? undefined,
        allocatedTeamIds,
    };
};

// All zones with their NSM associations. Associations are batch-loaded to avoid N queries per zone.
export const listDomains = async (): Promise<DnsZone[]> => {
    const zones = await getAllDnsZonesModel();
    const assignments = new Map((await getAllZoneAssignmentsModel()).map((a) => [a.zoneId, a.projectId]));
    const allocations = new Map<string, string[]>();
    for (const a of await getAllDomainAllocationsModel()) {
        const list = allocations.get(a.zoneId) ?? [];
        list.push(a.ownerId);
        allocations.set(a.zoneId, list);
    }
    return zones
        .map((z) => ({
            id: z.id,
            name: z.name,
            status: z.status,
            paused: z.paused,
            billing: z.billing,
            recordCount: z.recordCount,
            lastSyncedAt: z.lastSyncedAt,
            assignedProjectId: assignments.get(z.id) ?? undefined,
            allocatedTeamIds: allocations.get(z.id) ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
};

export const listRecords = async (zoneId: string): Promise<DnsRecord[]> => {
    return (await getRecordsForZoneModel(zoneId)).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
};

// Build the Cloudflare create/update body from a partial DnsRecord, honoring the dynamic-IP toggle:
// dynamic records get the marker written into their comment, and (for A/AAAA) their content set to
// the currently-detected public IP.
const buildCfInput = async (input: Partial<DnsRecord>, existing?: DnsRecord): Promise<CfDnsRecordInput> => {
    const type = (input.type || existing?.type)!;
    const name = (input.name ?? existing?.name)!;
    const dynamic = input.dynamic ?? existing?.dynamic ?? false;

    const body: CfDnsRecordInput = { type, name, ttl: input.ttl ?? existing?.ttl ?? 1 };

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

export const createRecord = async (zoneId: string, input: Partial<DnsRecord>): Promise<DnsRecord | undefined> => {
    if (!input.type || !input.name) throw new Error('type and name are required');
    const body = await buildCfInput({ ...input, zoneId });
    const created = await createDnsRecord(zoneId, body);
    dnsLog.info({ action: 'record_created', zoneId, recordId: created.id, type: body.type, name: body.name }, `created ${body.type} record ${body.name}`);
    return readBack(zoneId, created.id);
};

export const updateRecord = async (zoneId: string, recordId: string, input: Partial<DnsRecord>): Promise<DnsRecord | undefined> => {
    const existing = (await getRecordsForZoneModel(zoneId)).find((r) => r.id === recordId);
    if (!existing) throw new Error('record not found');
    const body = await buildCfInput({ ...input, zoneId }, existing);
    await updateDnsRecord(zoneId, recordId, body);
    dnsLog.info({ action: 'record_updated', zoneId, recordId, type: body.type, name: body.name }, `updated record ${body.name}`);
    return readBack(zoneId, recordId);
};

export const deleteRecord = async (zoneId: string, recordId: string): Promise<void> => {
    await deleteDnsRecord(zoneId, recordId);
    await syncZoneRecords(zoneId);
    dnsLog.info({ action: 'record_deleted', zoneId, recordId }, `deleted record ${recordId}`);
};

// Repush every DNS record bound to a port reservation so its port (SRV data.port) reflects the
// reservation's current value. Called after a reservation is created/updated/deleted. When the
// reservation no longer exists the binding is stripped from the record, keeping the last port value.
export const syncPortBoundRecords = async (reservationId: string): Promise<void> => {
    const records = await getRecordsByPortReservationModel(reservationId);
    if (!records.length) return;
    const reservation = await getPortReservationByIdModel(reservationId);
    const touchedZones = new Set<string>();
    for (const rec of records) {
        try {
            if (reservation) {
                const data = { ...(rec.data || {}), port: reservation.port };
                await updateDnsRecord(rec.zoneId, rec.id, { data, comment: setPortTag(rec.comment, reservationId) });
                dnsLog.info({ action: 'port_record_updated', recordId: rec.id, name: rec.name, type: rec.type, port: reservation.port }, `updated port-bound ${rec.type} ${rec.name} -> port ${reservation.port}`);
            } else {
                await updateDnsRecord(rec.zoneId, rec.id, { comment: removePortTag(rec.comment) || undefined });
                dnsLog.warn({ action: 'port_record_unbound', recordId: rec.id, name: rec.name, reservationId }, `reservation ${reservationId} gone; stripped port binding from ${rec.name}`);
            }
            touchedZones.add(rec.zoneId);
        } catch (e: any) {
            dnsLog.error({ action: 'port_record_update_failed', recordId: rec.id, err: e?.message }, `failed to update port-bound record ${rec.name}`);
        }
    }
    for (const zoneId of touchedZones) await syncZoneRecords(zoneId);
};

export const getPublicIp = async (): Promise<{ ip: string | null }> => ({ ip: await getKnownPublicIp() });

// On-demand: run the public-IP watcher now, repushing dynamic records if the WAN IP changed.
export const refreshPublicIp = async (): Promise<{ ip: string | null; changed: boolean }> => checkPublicIp();
