import { DnsRecord, DnsRecordType, DomainBilling } from '@mosaiq/nsm-common/types';
import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { cluster } from '@/cluster/node';
import { CfCreds, CfDnsRecord, CfRegistrarDomain, getPortReservationIdFromComment, hasDynamicTag, listDnsRecords, listRegistrarDomains, listZones } from '@/utils/cloudflare';
import { deleteDnsZonesNotInModelForAccount, getDnsZoneByNameModel, getDnsZoneModel, upsertDnsZoneModel } from '@/persistence/dnsZonePersistence';
import { deleteRecordsForZoneModel, replaceZoneRecordsModel } from '@/persistence/dnsRecordPersistence';
import { getAllAccountCreds, getCredsForZone } from '@/controllers/registrarController';
import { areaLog, serializeError } from '@/utils/log';

const syncLog = areaLog('cloudflare');

// Cloudflare stopped returning zone_id/zone_name on individual DNS records (EOL 2024-11-30), so the
// zone the record belongs to is taken from the zone being synced, not from the record payload.
const cfToRecord = (r: CfDnsRecord, zoneId: string): DnsRecord => ({
    id: r.id,
    zoneId,
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

// Cloudflare-authoritative mirror of one registrar account's zones + records + registrar metadata
// into the leader-local cache. Zones are tagged with the account id so sync and prune are scoped per
// account; a zone removed on Cloudflare is pruned (within this account only) along with its records.
// Throws on a Cloudflare failure so on-demand callers can surface the underlying error.
export const performAccountSync = async (account: RegistrarAccountRecord, creds: CfCreds): Promise<{ zoneCount: number }> => {
    const zones = await listZones(creds);

    const registrarByName = new Map<string, CfRegistrarDomain>();
    if (creds.accountId) {
        try {
            for (const r of await listRegistrarDomains(creds)) if (r.name) registrarByName.set(r.name.toLowerCase(), r);
        } catch (e: any) {
            syncLog.warn({ action: 'registrar_list_failed', accountId: account.id, err: serializeError(e) }, 'could not list registrar domains (registrar API may be unavailable)');
        }
    }

    for (const z of zones) {
        const existing = await getDnsZoneModel(z.id);
        const reg = registrarByName.get(z.name.toLowerCase());
        const records = await listDnsRecords(creds, z.id);
        await replaceZoneRecordsModel(z.id, records.map((r) => cfToRecord(r, z.id)));
        await upsertDnsZoneModel({
            id: z.id,
            name: z.name,
            status: z.status,
            paused: z.paused,
            billing: mergeBilling(existing?.billing, reg),
            registrarAccountId: account.id,
            recordCount: records.length,
            lastSyncedAt: Date.now(),
        });
    }

    const gone = await deleteDnsZonesNotInModelForAccount(account.id, zones.map((z) => z.id));
    for (const zoneId of gone) {
        await deleteRecordsForZoneModel(zoneId);
        syncLog.info({ action: 'zone_pruned', zoneId, accountId: account.id }, `pruned zone ${zoneId} no longer present on Cloudflare`);
    }

    syncLog.debug({ action: 'sync_complete', accountId: account.id, zoneCount: zones.length }, `synced ${zones.length} zone(s) for ${account.id}`);
    return { zoneCount: zones.length };
};

// Leader-only, cron-driven mirror across every configured registrar account. Failures are logged and
// swallowed per account so the scheduler keeps running and one bad account cannot block the rest.
export const syncCloudflare = async (): Promise<void> => {
    if (!cluster.isLeader()) return;
    for (const { account, creds } of await getAllAccountCreds()) {
        try {
            await performAccountSync(account, creds);
        } catch (e: any) {
            syncLog.error({ action: 'sync_failed', accountId: account.id, err: serializeError(e) }, 'Cloudflare sync failed');
        }
    }
};

// On-demand sync of a single account triggered from a team's domains UI. Returns a structured result
// instead of throwing so the caller can surface the exact Cloudflare error to the user.
export const syncAccountNow = async (account: RegistrarAccountRecord, creds: CfCreds): Promise<{ ok: boolean; zoneCount?: number; error?: string }> => {
    if (!creds.apiToken) return { ok: false, error: 'Registrar is not configured for this team.' };
    try {
        const { zoneCount } = await performAccountSync(account, creds);
        return { ok: true, zoneCount };
    } catch (e: any) {
        syncLog.error({ action: 'sync_failed', accountId: account.id, err: serializeError(e) }, 'Cloudflare sync failed');
        return { ok: false, error: e?.message || 'Cloudflare sync failed' };
    }
};

// Refresh a single zone's cached records after an in-NSM write, without a full re-sync. Resolves the
// zone's registrar account credentials internally so callers need not thread them.
export const syncZoneRecords = async (zoneId: string): Promise<void> => {
    const creds = await getCredsForZone(zoneId);
    if (!creds?.apiToken) return;
    try {
        const records = await listDnsRecords(creds, zoneId);
        await replaceZoneRecordsModel(zoneId, records.map((r) => cfToRecord(r, zoneId)));
        const existing = await getDnsZoneModel(zoneId);
        if (existing) await upsertDnsZoneModel({ ...existing, recordCount: records.length, lastSyncedAt: Date.now() });
    } catch (e: any) {
        syncLog.error({ action: 'zone_sync_failed', zoneId, err: serializeError(e) }, `failed to refresh zone ${zoneId}`);
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
