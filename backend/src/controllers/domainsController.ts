import * as crypto from 'crypto';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { DomainAllocationResult, DomainBillingSummary, DomainCheckResult, DomainRequest, DomainRequestStatus, DomainSearchResult, ProjectNginxConfig, User } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { CfDomainSuggestion, checkDomains as cfCheckDomains, createZone, deleteZone, getRegistrationStatus, registerDomain, searchDomains as cfSearchDomains, setRegistrarAutoRenew } from '@/utils/cloudflare';
import { recordZonePurchasePrice, syncCloudflare } from '@/reconcile/cloudflareSync';
import { deleteDnsZoneModel, getAllDnsZonesModel, getDnsZoneByNameModel, getDnsZoneModel } from '@/persistence/dnsZonePersistence';
import { deleteRecordsForZoneModel } from '@/persistence/dnsRecordPersistence';
import { getAllocationsForZoneModel, getZonesForOwnerModel } from '@/persistence/domainTeamAllocationPersistence';
import { getDomainRequestModel, getAllDomainRequestsModel, getDomainRequestsByRequesterModel } from '@/persistence/domainRequestPersistence';
import { getAllProjectsModel, getProjectByIdModel } from '@/persistence/projectPersistence';
import { resolveTeamById, resolveTeamByLogin, isSuperAdmin } from '@/controllers/authz';
import { getUserByLoginModel } from '@/persistence/userPersistence';
import { sendPushToGithubIds } from '@/controllers/pushController';
import { areaLog, serializeError } from '@/utils/log';

const domainsLog = areaLog('cloudflare');

const toSearchResult = (s: CfDomainSuggestion): DomainSearchResult => ({
    name: s.name,
    registrable: !!s.registrable,
    tier: s.tier,
    reason: s.reason,
    currency: s.pricing?.currency,
    registrationCost: s.pricing?.registration_cost,
    renewalCost: s.pricing?.renewal_cost,
});

export const searchDomains = async (query: string): Promise<DomainSearchResult[]> => {
    if (!query.trim()) return [];
    return (await cfSearchDomains(query.trim())).map(toSearchResult);
};

export const checkDomains = async (domains: string[]): Promise<DomainCheckResult[]> => {
    if (!domains.length) return [];
    return (await cfCheckDomains(domains)).map(toSearchResult);
};

// The super admin's githubId (for purchase-request notifications), or null if they've never signed in.
const superAdminGithubId = async (): Promise<string | null> => {
    const login = process.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
    if (!login) return null;
    const user = await getUserByLoginModel(login);
    return user?.githubId ?? null;
};

const notify = async (githubId: string | null | undefined, title: string, body: string): Promise<void> => {
    if (!githubId) return;
    try {
        await sendPushToGithubIds([githubId], JSON.stringify({ title, body, url: '/domains', tag: 'nsm-domain' }));
    } catch (e: any) {
        domainsLog.warn({ action: 'notify_failed', err: serializeError(e) }, 'failed to send domain notification');
    }
};

// A configurer submits a purchase request (never buys). Notifies the super admin.
export const createRequest = async (user: User, domainName: string, ownerId: string, price: { priceCurrency?: string; priceRegistration?: string; priceRenewal?: string }): Promise<DomainRequest> => {
    const team = await resolveTeamById(ownerId);
    const now = Date.now();
    const request: DomainRequest = {
        id: crypto.randomUUID(),
        domainName: domainName.trim().toLowerCase(),
        requesterId: user.githubId,
        requesterLogin: user.name,
        ownerId,
        ownerLogin: team?.login,
        priceCurrency: price.priceCurrency,
        priceRegistration: price.priceRegistration,
        priceRenewal: price.priceRenewal,
        status: DomainRequestStatus.PENDING,
        createdAt: now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request });
    domainsLog.info({ action: 'domain_requested', domainName: request.domainName, requester: user.name }, `${user.name} requested ${request.domainName}`);
    await notify(await superAdminGithubId(), 'Domain purchase requested', `${user.name} requested to purchase ${request.domainName}.`);
    return request;
};

export const listRequests = async (user: User): Promise<DomainRequest[]> => {
    if (isSuperAdmin(user)) return getAllDomainRequestsModel();
    return getDomainRequestsByRequesterModel(user.githubId);
};

// Poll a registration workflow until it reaches a terminal state (or times out).
const pollRegistration = async (domainName: string): Promise<{ ok: boolean; state?: string; error?: string }> => {
    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const status = await getRegistrationStatus(domainName);
            const state = (status.state || '').toLowerCase();
            if (status.completed && (state === 'succeeded' || state === 'active' || state === 'registered')) return { ok: true, state };
            if (state === 'failed' || state === 'blocked' || state === 'action_required') return { ok: false, state, error: status.error?.message };
        } catch (e: any) {
            domainsLog.warn({ action: 'registration_poll_error', domainName, err: serializeError(e) }, 'error polling registration status');
        }
    }
    return { ok: false, state: 'timeout', error: 'Registration did not complete in time; check the Cloudflare dashboard.' };
};

// Super-admin decision on a purchase request. Deny -> notify requester. Approve -> re-check price,
// register (spends money), adopt/create the zone, allocate to the requester's team, notify.
export const decideRequest = async (decider: User, requestId: string, approve: boolean, reason?: string): Promise<DomainRequest | undefined> => {
    const request = await getDomainRequestModel(requestId);
    if (!request) throw new Error('request not found');
    if (request.status !== DomainRequestStatus.PENDING) throw new Error(`request is already ${request.status}`);

    const save = async (patch: Partial<DomainRequest>): Promise<DomainRequest> => {
        const updated: DomainRequest = { ...request, ...patch, decidedById: decider.githubId, decidedByLogin: decider.name, updatedAt: Date.now() };
        await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request: updated });
        return updated;
    };

    if (!approve) {
        const denied = await save({ status: DomainRequestStatus.DENIED, reason: reason || 'Denied' });
        await notify(request.requesterId, 'Domain request denied', `Your request for ${request.domainName} was denied${reason ? `: ${reason}` : '.'}`);
        return denied;
    }

    // Mark purchasing so the UI reflects it during the (possibly slow) registration.
    await save({ status: DomainRequestStatus.PURCHASING });

    try {
        // Re-check availability + price immediately before buying (registrations are non-refundable).
        const [check] = await cfCheckDomains([request.domainName]);
        if (!check || !check.registrable) {
            const failed = await save({ status: DomainRequestStatus.FAILED, reason: 'Domain is no longer available.' });
            await notify(request.requesterId, 'Domain purchase failed', `${request.domainName} is no longer available.`);
            return failed;
        }

        const start = await registerDomain(request.domainName, 1, true);
        let ok = start.completed && ['succeeded', 'active', 'registered'].includes((start.state || '').toLowerCase());
        let failInfo: { state?: string; error?: string } = {};
        if (!ok) {
            const polled = await pollRegistration(request.domainName);
            ok = polled.ok;
            failInfo = polled;
        }
        if (!ok) {
            const failed = await save({ status: DomainRequestStatus.FAILED, reason: failInfo.error || `Registration ${failInfo.state || 'failed'}` });
            await notify(request.requesterId, 'Domain purchase failed', `Purchasing ${request.domainName} failed: ${failInfo.error || failInfo.state || 'unknown error'}.`);
            return failed;
        }

        // Adopt the zone (registration usually auto-creates it); create it if not present after a sync.
        await syncCloudflare();
        let zone = await getDnsZoneByNameModel(request.domainName);
        if (!zone) {
            try {
                await createZone(request.domainName);
            } catch (e: any) {
                domainsLog.warn({ action: 'zone_create_after_purchase_failed', domainName: request.domainName, err: serializeError(e) }, 'zone auto-create after purchase failed');
            }
            await syncCloudflare();
            zone = await getDnsZoneByNameModel(request.domainName);
        }

        if (zone) {
            await recordZonePurchasePrice(zone.name, { currency: check.pricing?.currency ?? request.priceCurrency, registrationCost: check.pricing?.registration_cost ?? request.priceRegistration, renewalCost: check.pricing?.renewal_cost ?? request.priceRenewal });
            if (request.ownerId) {
                const existing = await getAllocationsForZoneModel(zone.id);
                await cluster.propose({ type: OpType.SET_DOMAIN_ALLOCATIONS, zoneId: zone.id, ownerIds: [...new Set([...existing, request.ownerId])] });
            }
        }

        const purchased = await save({ status: DomainRequestStatus.PURCHASED });
        await notify(request.requesterId, 'Domain purchased', `${request.domainName} was purchased and set up in NSM.`);
        domainsLog.info({ action: 'domain_purchased', domainName: request.domainName, by: decider.name }, `purchased ${request.domainName}`);
        return purchased;
    } catch (e: any) {
        const failed = await save({ status: DomainRequestStatus.FAILED, reason: e?.message || 'Purchase failed' });
        await notify(request.requesterId, 'Domain purchase failed', `Purchasing ${request.domainName} failed: ${e?.message || 'unknown error'}.`);
        domainsLog.error({ action: 'domain_purchase_error', domainName: request.domainName, err: serializeError(e) }, 'domain purchase errored');
        return failed;
    }
};

// Whether a project references a domain (apex or any subdomain of it) in its nginx config.
const projectUsesDomain = (nginxConfigJson: string | undefined, zoneName: string): boolean => {
    if (!nginxConfigJson) return false;
    try {
        const cfg = JSON.parse(nginxConfigJson) as ProjectNginxConfig;
        const zn = zoneName.toLowerCase();
        return (cfg.servers || []).some((s) => {
            const d = (s.domain || '').toLowerCase();
            return d === zn || d.endsWith(`.${zn}`);
        });
    } catch {
        return false;
    }
};

// Set the teams allowed to use a domain. Refuses to remove a team while any of its projects still
// reference the domain, returning the blocking projects instead of applying the change.
export const setAllocations = async (zoneId: string, ownerIds: string[]): Promise<DomainAllocationResult> => {
    const zone = await getDnsZoneModel(zoneId);
    if (!zone) throw new Error('domain not found');
    const current = await getAllocationsForZoneModel(zoneId);
    const removed = current.filter((id) => !ownerIds.includes(id));

    if (removed.length) {
        const projects = await getAllProjectsModel();
        const blockedBy: { projectId: string; ownerLogin: string }[] = [];
        for (const ownerId of removed) {
            const team = await resolveTeamById(ownerId);
            if (!team) continue;
            for (const p of projects) {
                if (p.repoOwner.toLowerCase() === team.login.toLowerCase() && projectUsesDomain(p.nginxConfigJson, zone.name)) {
                    blockedBy.push({ projectId: p.id, ownerLogin: team.login });
                }
            }
        }
        if (blockedBy.length) return { ok: false, blockedBy };
    }

    await cluster.propose({ type: OpType.SET_DOMAIN_ALLOCATIONS, zoneId, ownerIds: [...new Set(ownerIds)] });
    return { ok: true };
};

// Super-admin only: delete the zone from Cloudflare (stops DNS) and best-effort disable registrar
// auto-renew (stops billing). Requires the typed domain name to match.
export const deleteDomain = async (zoneId: string, confirmName: string): Promise<void> => {
    const zone = await getDnsZoneModel(zoneId);
    if (!zone) throw new Error('domain not found');
    if (confirmName.trim().toLowerCase() !== zone.name.toLowerCase()) throw new Error('Confirmation does not match the domain name.');

    await deleteZone(zoneId);
    try {
        await setRegistrarAutoRenew(zone.name, false);
    } catch (e: any) {
        domainsLog.warn({ action: 'auto_renew_disable_failed', domainName: zone.name, err: serializeError(e) }, `could not disable auto-renew for ${zone.name}; disable it in the Cloudflare dashboard to stop billing`);
    }

    await deleteRecordsForZoneModel(zoneId);
    await deleteDnsZoneModel(zoneId);
    await cluster.propose({ type: OpType.SET_DOMAIN_ALLOCATIONS, zoneId, ownerIds: [] });
    domainsLog.info({ action: 'domain_deleted', domainName: zone.name }, `deleted domain ${zone.name}`);
};

export const billingSummary = async (): Promise<DomainBillingSummary> => {
    const zones = await getAllDnsZonesModel();
    const entries = zones.map((z) => ({ zoneId: z.id, name: z.name, renewalCost: z.billing?.renewalCost, currency: z.billing?.currency, expiresAt: z.billing?.expiresAt, autoRenew: z.billing?.autoRenew }));
    const byCurrency = new Map<string, number>();
    for (const e of entries) {
        const cost = parseFloat(e.renewalCost || '');
        if (!e.currency || isNaN(cost)) continue;
        byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + cost);
    }
    const totalsByCurrency = [...byCurrency.entries()].map(([currency, yearly]) => ({ currency, yearly, monthly: yearly / 12 }));
    return { entries, totalsByCurrency };
};

// Team-scoped list of allocated domain names for a project's owning team, for the config picker.
export const listProjectDomains = async (projectId: string): Promise<string[]> => {
    const project = await getProjectByIdModel(projectId);
    if (!project) return [];
    const team = await resolveTeamByLogin(project.repoOwner);
    if (!team) return [];
    const zoneIds = await getZonesForOwnerModel(team.ownerId);
    const names: string[] = [];
    for (const zoneId of zoneIds) {
        const zone = await getDnsZoneModel(zoneId);
        if (zone) names.push(zone.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
};
