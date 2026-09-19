import { DnsRecord, DnsRecordType, DomainBilling } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { isCloudflareConfigured, isCloudflareRegistrarConfigured } from '@/config';
import { CfDnsRecord, CfRegistrarDomain, getPortReservationIdFromComment, hasDynamicTag, listDnsRecords, listRegistrarDomains, listZones } from '@/utils/cloudflare';
import { deleteDnsZonesNotInModel, getDnsZoneByNameModel, getDnsZoneModel, upsertDnsZoneModel } from '@/persistence/dnsZonePersistence';
import { deleteRecordsForZoneModel, replaceZoneRecordsModel } from '@/persistence/dnsRecordPersistence';
import { setZoneAssignmentModel } from '@/persistence/dnsZoneAssignmentPersistence';
import { setDomainAllocationsModel } from '@/persistence/domainTeamAllocationPersistence';
import { areaLog } from '@/utils/log';

const syncLog = areaLog('cloudflare');

const cfToRecord = (r: CfDnsRecord): DnsRecord => ({
    id: r.id,
    zoneId: r.zone_id,
    type: r.type as DnsRecordType,
    name: r.name,
    content: r.content,
    proxied: r.proxied,
    ttl: r.ttl,
    priority: r.priority,
    data: r.data,
    comment: r.comment,
    dynamic: hasDynamicTag(r.comment),
    portReservationId: getPortReservationIdFromComment(r.comment),
});

// Cloudflare is authoritative for expiry/auto-renew/status; pricing is not returned for owned
// domains, so we preserve any pricing NSM cached at purchase time.
const mergeBilling = (existing: DomainBilling | undefined, reg: CfRegistrarDomain | undefined): DomainBilling | undefined => {
    if (!reg && !existing) return undefined;
    return {
        expiresAt: reg?.expires_at ?? existing?.expiresAt,
        autoRenew: reg?.auto_renew ?? existing?.autoRenew,
        registrationStatus: reg?.status ?? existing?.registrationStatus,
        currency: existing?.currency,
        registrationCost: existing?.registrationCost,
        renewalCost: existing?.renewalCost,
    };
};

// Leader-only, Cloudflare-authoritative mirror of zones + records + registrar metadata into the
// leader-local cache. Cascades external changes: zones removed on Cloudflare are pruned from the
// cache along with their records and NSM associations.
export const syncCloudflare = async (): Promise<void> => {
    if (!cluster.isLeader() || !isCloudflareConfigured()) return;
    try {
        const zones = await listZones();

        const registrarByName = new Map<string, CfRegistrarDomain>();
        if (isCloudflareRegistrarConfigured()) {
            try {
                for (const r of await listRegistrarDomains()) if (r.name) registrarByName.set(r.name.toLowerCase(), r);
            } catch (e: any) {
                syncLog.warn({ action: 'registrar_list_failed', err: e?.message }, 'could not list registrar domains (registrar API may be unavailable)');
            }
        }

        for (const z of zones) {
            const existing = await getDnsZoneModel(z.id);
            const reg = registrarByName.get(z.name.toLowerCase());
            const records = await listDnsRecords(z.id);
            await replaceZoneRecordsModel(z.id, records.map(cfToRecord));
            await upsertDnsZoneModel({
                id: z.id,
                name: z.name,
                status: z.status,
                paused: z.paused,
                billing: mergeBilling(existing?.billing, reg),
                recordCount: records.length,
                lastSyncedAt: Date.now(),
            });
        }

        const gone = await deleteDnsZonesNotInModel(zones.map((z) => z.id));
        for (const zoneId of gone) {
            await deleteRecordsForZoneModel(zoneId);
            await setZoneAssignmentModel(zoneId, null);
            await setDomainAllocationsModel(zoneId, []);
            syncLog.info({ action: 'zone_pruned', zoneId }, `pruned zone ${zoneId} no longer present on Cloudflare`);
        }

        syncLog.debug({ action: 'sync_complete', zoneCount: zones.length }, `synced ${zones.length} Cloudflare zone(s)`);
    } catch (e: any) {
        syncLog.error({ action: 'sync_failed', err: e?.message }, 'Cloudflare sync failed');
    }
};

// Refresh a single zone's cached records after an in-NSM write, without a full re-sync.
export const syncZoneRecords = async (zoneId: string): Promise<void> => {
    if (!isCloudflareConfigured()) return;
    try {
        const records = await listDnsRecords(zoneId);
        await replaceZoneRecordsModel(zoneId, records.map(cfToRecord));
        const existing = await getDnsZoneModel(zoneId);
        if (existing) await upsertDnsZoneModel({ ...existing, recordCount: records.length, lastSyncedAt: Date.now() });
    } catch (e: any) {
        syncLog.error({ action: 'zone_sync_failed', zoneId, err: e?.message }, `failed to refresh zone ${zoneId}`);
    }
};

// Persist a purchase-time price onto a cached zone's billing so the billing summary can show it
// (Cloudflare does not return pricing for owned domains). Looked up by name after a purchase+sync.
export const recordZonePurchasePrice = async (zoneName: string, price: { currency?: string; registrationCost?: string; renewalCost?: string }): Promise<void> => {
    const zone = await getDnsZoneByNameModel(zoneName);
    if (!zone) return;
    await upsertDnsZoneModel({
        ...zone,
        billing: {
            ...(zone.billing || {}),
            currency: price.currency ?? zone.billing?.currency,
            registrationCost: price.registrationCost ?? zone.billing?.registrationCost,
            renewalCost: price.renewalCost ?? zone.billing?.renewalCost,
        },
    });
};
