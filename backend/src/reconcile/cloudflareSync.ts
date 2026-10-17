import { DomainBilling } from '@mosaiq/nsm-common/types';
import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { cluster } from '@/cluster/node';
import { RegistrarDomainMeta, getDnsProvider } from '@/registrar/provider';
import { deleteDnsZonesNotInModelForAccount, getDnsZoneByNameModel, getDnsZoneModel, upsertDnsZoneModel } from '@/persistence/dnsZonePersistence';
import { deleteRecordsForZoneModel, replaceZoneRecordsModel } from '@/persistence/dnsRecordPersistence';
import { getAllAccountProviders, getProviderForZone } from '@/controllers/registrarController';
import { areaLog, serializeError } from '@/utils/log';

const syncLog = areaLog('dns');

// The registrar is authoritative for expiry/auto-renew/status; pricing is not returned for owned
// domains, so we preserve any pricing NSM cached at purchase time.
const mergeBilling = (existing: DomainBilling | undefined, reg: RegistrarDomainMeta | undefined): DomainBilling | undefined => {
    if (!reg && !existing) return undefined;
    return {
        expiresAt: reg?.expiresAt ?? existing?.expiresAt,
        autoRenew: reg?.autoRenew ?? existing?.autoRenew,
        registrationStatus: reg?.status ?? existing?.registrationStatus,
        currency: existing?.currency,
        registrationCost: existing?.registrationCost,
        renewalCost: existing?.renewalCost,
    };
};

// Registrar-authoritative mirror of one account's zones + records + registrar metadata into the
// leader-local cache. Zones are tagged with the account id so sync and prune are scoped per account;
// a zone removed at the registrar is pruned (within this account only) along with its records.
// Throws on a provider failure so on-demand callers can surface the underlying error.
export const performAccountSync = async (account: RegistrarAccountRecord): Promise<{ zoneCount: number }> => {
    const provider = getDnsProvider(account);
    const zones = await provider.listZones();

    const registrarByName = new Map<string, RegistrarDomainMeta>();
    try {
        for (const r of await provider.listRegistrarDomains()) if (r.name) registrarByName.set(r.name.toLowerCase(), r);
    } catch (e: any) {
        syncLog.warn({ action: 'registrar_list_failed', accountId: account.id, err: serializeError(e) }, 'could not list registrar domains (registrar API may be unavailable)');
    }

    for (const z of zones) {
        const existing = await getDnsZoneModel(z.id);
        const reg = registrarByName.get(z.name.toLowerCase());
        const records = await provider.listRecords({ id: z.id, name: z.name });
        await replaceZoneRecordsModel(z.id, records);
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
        syncLog.info({ action: 'zone_pruned', zoneId, accountId: account.id }, `pruned zone ${zoneId} no longer present at the registrar`);
    }

    syncLog.debug({ action: 'sync_complete', accountId: account.id, zoneCount: zones.length }, `synced ${zones.length} zone(s) for ${account.id}`);
    return { zoneCount: zones.length };
};

// Leader-only, cron-driven mirror across every configured registrar account. Failures are logged and
// swallowed per account so the scheduler keeps running and one bad account cannot block the rest.
export const syncCloudflare = async (): Promise<void> => {
    if (!cluster.isLeader()) return;
    for (const { account } of await getAllAccountProviders()) {
        try {
            await performAccountSync(account);
        } catch (e: any) {
            syncLog.error({ action: 'sync_failed', accountId: account.id, err: serializeError(e) }, 'registrar sync failed');
        }
    }
};

// On-demand sync of a single account triggered from a team's domains UI. Returns a structured result
// instead of throwing so the caller can surface the exact provider error to the user.
export const syncAccountNow = async (account: RegistrarAccountRecord): Promise<{ ok: boolean; zoneCount?: number; error?: string }> => {
    const provider = getDnsProvider(account);
    if (!provider.hasRemoteConfig()) return { ok: false, error: 'Registrar is not configured for this team.' };
    try {
        const { zoneCount } = await performAccountSync(account);
        return { ok: true, zoneCount };
    } catch (e: any) {
        syncLog.error({ action: 'sync_failed', accountId: account.id, err: serializeError(e) }, 'registrar sync failed');
        return { ok: false, error: e?.message || 'Registrar sync failed' };
    }
};

// Refresh a single zone's cached records after an in-NSM write, without a full re-sync. Resolves the
// zone's registrar account/provider internally so callers need not thread them.
export const syncZoneRecords = async (zoneId: string): Promise<void> => {
    const resolved = await getProviderForZone(zoneId);
    if (!resolved || !resolved.provider.hasRemoteConfig()) return;
    const zone = await getDnsZoneModel(zoneId);
    if (!zone) return;
    try {
        const records = await resolved.provider.listRecords({ id: zone.id, name: zone.name });
        await replaceZoneRecordsModel(zoneId, records);
        await upsertDnsZoneModel({ ...zone, recordCount: records.length, lastSyncedAt: Date.now() });
    } catch (e: any) {
        syncLog.error({ action: 'zone_sync_failed', zoneId, err: serializeError(e) }, `failed to refresh zone ${zoneId}`);
    }
};

// Persist a purchase-time price onto a cached zone's billing so the billing summary can show it
// (registrars do not return pricing for owned domains). Looked up by name after a purchase+sync.
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
