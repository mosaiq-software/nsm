import * as crypto from 'crypto';
import { OpType, RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { DomainBillingSummary, DomainCheckResult, DomainRequest, DomainRequestStatus, DomainSearchResult, Team, TeamType, User } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { CfCreds, CfDomainSuggestion, checkDomains as cfCheckDomains, createZone, deleteZone, getRegistrationStatus, registerDomain, searchDomains as cfSearchDomains, setRegistrarAutoRenew } from '@/utils/cloudflare';
import { performAccountSync, recordZonePurchasePrice } from '@/reconcile/cloudflareSync';
import { deleteDnsZoneModel, getDnsZoneByNameModel, getDnsZoneModel, getDnsZonesForAccountModel } from '@/persistence/dnsZonePersistence';
import { deleteRecordsForZoneModel } from '@/persistence/dnsRecordPersistence';
import { getDomainRequestModel, getDomainRequestsByOwnerModel } from '@/persistence/domainRequestPersistence';
import { getProjectByIdModel } from '@/persistence/projectPersistence';
import { listOrgOwnersForTeam, resolveTeamByLogin } from '@/controllers/authz';
import { getCredsForTeam, getRegistrarAccountForTeam } from '@/controllers/registrarController';
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

export const searchDomains = async (creds: CfCreds, query: string): Promise<DomainSearchResult[]> => {
    if (!query.trim()) return [];
    return (await cfSearchDomains(creds, query.trim())).map(toSearchResult);
};

export const checkDomains = async (creds: CfCreds, domains: string[]): Promise<DomainCheckResult[]> => {
    if (!domains.length) return [];
    return (await cfCheckDomains(creds, domains)).map(toSearchResult);
};

// GitHub ids of a team's owners, used to route purchase-request notifications to the approvers.
const teamOwnerGithubIds = async (team: Team): Promise<string[]> => {
    if (team.type === TeamType.USER) return [team.ownerId];
    const owners = await listOrgOwnersForTeam(team.login);
    return owners.map((o) => o.id).filter(Boolean);
};

const notify = async (githubIds: string[], ownerId: string, title: string, body: string): Promise<void> => {
    const ids = [...new Set(githubIds.filter(Boolean))];
    if (!ids.length) return;
    try {
        await sendPushToGithubIds(ids, JSON.stringify({ title, body, url: `/teams/${ownerId}`, tag: 'nsm-domain' }));
    } catch (e: any) {
        domainsLog.warn({ action: 'notify_failed', err: serializeError(e) }, 'failed to send domain notification');
    }
};

// A non-owner team member submits a purchase request (never buys). Notifies the team's owners.
export const createRequest = async (user: User, team: Team, domainName: string, price: { priceCurrency?: string; priceRegistration?: string; priceRenewal?: string }): Promise<DomainRequest> => {
    const now = Date.now();
    const request: DomainRequest = {
        id: crypto.randomUUID(),
        domainName: domainName.trim().toLowerCase(),
        requesterId: user.githubId,
        requesterLogin: user.name,
        ownerId: team.ownerId,
        ownerLogin: team.login,
        priceCurrency: price.priceCurrency,
        priceRegistration: price.priceRegistration,
        priceRenewal: price.priceRenewal,
        status: DomainRequestStatus.PENDING,
        createdAt: now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request });
    domainsLog.info({ action: 'domain_requested', domainName: request.domainName, requester: user.name, ownerId: team.ownerId }, `${user.name} requested ${request.domainName}`);
    await notify(await teamOwnerGithubIds(team), team.ownerId, 'Domain purchase requested', `${user.name} requested to purchase ${request.domainName}.`);
    return request;
};

export const listTeamRequests = async (ownerId: string): Promise<DomainRequest[]> => getDomainRequestsByOwnerModel(ownerId);

// Poll a registration workflow until it reaches a terminal state (or times out).
const pollRegistration = async (creds: CfCreds, domainName: string): Promise<{ ok: boolean; state?: string; error?: string }> => {
    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const status = await getRegistrationStatus(creds, domainName);
            const state = (status.state || '').toLowerCase();
            if (status.completed && (state === 'succeeded' || state === 'active' || state === 'registered')) return { ok: true, state };
            if (state === 'failed' || state === 'blocked' || state === 'action_required') return { ok: false, state, error: status.error?.message };
        } catch (e: any) {
            domainsLog.warn({ action: 'registration_poll_error', domainName, err: serializeError(e) }, 'error polling registration status');
        }
    }
    return { ok: false, state: 'timeout', error: 'Registration did not complete in time; check the Cloudflare dashboard.' };
};

// Shared purchase path for both owner self-service (buy) and request approval. Re-checks price,
// registers (spends money), adopts/creates the zone under the account, records price, and notifies
// the requester. The request status is advanced in place.
const performPurchase = async (request: DomainRequest, account: RegistrarAccountRecord, creds: CfCreds): Promise<DomainRequest> => {
    const save = async (patch: Partial<DomainRequest>): Promise<DomainRequest> => {
        const updated: DomainRequest = { ...request, ...patch, updatedAt: Date.now() };
        await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request: updated });
        return updated;
    };

    try {
        // Re-check availability + price immediately before buying (registrations are non-refundable).
        const [check] = await cfCheckDomains(creds, [request.domainName]);
        if (!check || !check.registrable) {
            const failed = await save({ status: DomainRequestStatus.FAILED, reason: 'Domain is no longer available.' });
            await notify([request.requesterId], request.ownerId || '', 'Domain purchase failed', `${request.domainName} is no longer available.`);
            return failed;
        }

        const start = await registerDomain(creds, request.domainName, 1, true);
        let ok = start.completed && ['succeeded', 'active', 'registered'].includes((start.state || '').toLowerCase());
        let failInfo: { state?: string; error?: string } = {};
        if (!ok) {
            const polled = await pollRegistration(creds, request.domainName);
            ok = polled.ok;
            failInfo = polled;
        }
        if (!ok) {
            const failed = await save({ status: DomainRequestStatus.FAILED, reason: failInfo.error || `Registration ${failInfo.state || 'failed'}` });
            await notify([request.requesterId], request.ownerId || '', 'Domain purchase failed', `Purchasing ${request.domainName} failed: ${failInfo.error || failInfo.state || 'unknown error'}.`);
            return failed;
        }

        // Adopt the zone (registration usually auto-creates it); create it if not present after a sync.
        await performAccountSync(account, creds);
        let zone = await getDnsZoneByNameModel(request.domainName);
        if (!zone) {
            try {
                await createZone(creds, request.domainName);
            } catch (e: any) {
                domainsLog.warn({ action: 'zone_create_after_purchase_failed', domainName: request.domainName, err: serializeError(e) }, 'zone auto-create after purchase failed');
            }
            await performAccountSync(account, creds);
            zone = await getDnsZoneByNameModel(request.domainName);
        }

        if (zone) {
            await recordZonePurchasePrice(zone.name, { currency: check.pricing?.currency ?? request.priceCurrency, registrationCost: check.pricing?.registration_cost ?? request.priceRegistration, renewalCost: check.pricing?.renewal_cost ?? request.priceRenewal });
        }

        const purchased = await save({ status: DomainRequestStatus.PURCHASED });
        await notify([request.requesterId], request.ownerId || '', 'Domain purchased', `${request.domainName} was purchased and set up in NSM.`);
        domainsLog.info({ action: 'domain_purchased', domainName: request.domainName, ownerId: request.ownerId }, `purchased ${request.domainName}`);
        return purchased;
    } catch (e: any) {
        const failed = await save({ status: DomainRequestStatus.FAILED, reason: e?.message || 'Purchase failed' });
        await notify([request.requesterId], request.ownerId || '', 'Domain purchase failed', `Purchasing ${request.domainName} failed: ${e?.message || 'unknown error'}.`);
        domainsLog.error({ action: 'domain_purchase_error', domainName: request.domainName, err: serializeError(e) }, 'domain purchase errored');
        return failed;
    }
};

// Owner self-service: buy a domain directly on the team's registrar account (no approval needed).
export const buyDomain = async (user: User, team: Team, account: RegistrarAccountRecord, creds: CfCreds, domainName: string, price: { priceCurrency?: string; priceRegistration?: string; priceRenewal?: string }): Promise<DomainRequest> => {
    const now = Date.now();
    const request: DomainRequest = {
        id: crypto.randomUUID(),
        domainName: domainName.trim().toLowerCase(),
        requesterId: user.githubId,
        requesterLogin: user.name,
        ownerId: team.ownerId,
        ownerLogin: team.login,
        priceCurrency: price.priceCurrency,
        priceRegistration: price.priceRegistration,
        priceRenewal: price.priceRenewal,
        status: DomainRequestStatus.PURCHASING,
        decidedById: user.githubId,
        decidedByLogin: user.name,
        createdAt: now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request });
    return performPurchase(request, account, creds);
};

// Team owner decision on a pending request. Deny -> notify requester. Approve -> run the purchase.
export const decideRequest = async (decider: User, ownerId: string, account: RegistrarAccountRecord, creds: CfCreds, requestId: string, approve: boolean, reason?: string): Promise<DomainRequest | undefined> => {
    const request = await getDomainRequestModel(requestId);
    if (!request) throw new Error('request not found');
    if (request.ownerId !== ownerId) throw new Error('request does not belong to this team');
    if (request.status !== DomainRequestStatus.PENDING) throw new Error(`request is already ${request.status}`);

    const decided: DomainRequest = { ...request, decidedById: decider.githubId, decidedByLogin: decider.name, updatedAt: Date.now() };

    if (!approve) {
        const denied: DomainRequest = { ...decided, status: DomainRequestStatus.DENIED, reason: reason || 'Denied' };
        await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request: denied });
        await notify([request.requesterId], ownerId, 'Domain request denied', `Your request for ${request.domainName} was denied${reason ? `: ${reason}` : '.'}`);
        return denied;
    }

    const purchasing: DomainRequest = { ...decided, status: DomainRequestStatus.PURCHASING };
    await cluster.propose({ type: OpType.UPSERT_DOMAIN_REQUEST, request: purchasing });
    return performPurchase(purchasing, account, creds);
};

// Delete the zone from Cloudflare (stops DNS) and best-effort disable registrar auto-renew (stops
// billing). Requires the typed domain name to match. Shared accounts: this affects every team.
export const deleteDomain = async (creds: CfCreds, zoneId: string, confirmName: string): Promise<void> => {
    const zone = await getDnsZoneModel(zoneId);
    if (!zone) throw new Error('domain not found');
    if (confirmName.trim().toLowerCase() !== zone.name.toLowerCase()) throw new Error('Confirmation does not match the domain name.');

    await deleteZone(creds, zoneId);
    try {
        await setRegistrarAutoRenew(creds, zone.name, false);
    } catch (e: any) {
        domainsLog.warn({ action: 'auto_renew_disable_failed', domainName: zone.name, err: serializeError(e) }, `could not disable auto-renew for ${zone.name}; disable it in the Cloudflare dashboard to stop billing`);
    }

    await deleteRecordsForZoneModel(zoneId);
    await deleteDnsZoneModel(zoneId);
    domainsLog.info({ action: 'domain_deleted', domainName: zone.name }, `deleted domain ${zone.name}`);
};

export const billingSummaryForAccount = async (accountId: string): Promise<DomainBillingSummary> => {
    const zones = await getDnsZonesForAccountModel(accountId);
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

// Team-scoped list of a project's domain names (its owning team's registrar account zones), for the
// nginx config domain picker. Empty when the project's team has no registrar configured.
export const listProjectDomains = async (projectId: string): Promise<string[]> => {
    const project = await getProjectByIdModel(projectId);
    if (!project) return [];
    const team = await resolveTeamByLogin(project.repoOwner);
    if (!team) return [];
    const account = await getRegistrarAccountForTeam(team.ownerId);
    if (!account) return [];
    const zones = await getDnsZonesForAccountModel(account.id);
    return zones.map((z) => z.name).sort((a, b) => a.localeCompare(b));
};

// Resolve a team's registrar account + credentials, throwing a user-facing error if unconfigured.
export const requireTeamCreds = async (ownerId: string): Promise<{ account: RegistrarAccountRecord; creds: CfCreds }> => {
    const account = await getRegistrarAccountForTeam(ownerId);
    const creds = account ? await getCredsForTeam(ownerId) : null;
    if (!account || !creds?.apiToken) throw new Error('This team has no registrar configured.');
    return { account, creds };
};

// Like requireTeamCreds but also verifies the zone belongs to the team's registrar account, so a
// team can only read/write DNS for its own domains.
export const requireTeamZoneCreds = async (ownerId: string, zoneId: string): Promise<{ account: RegistrarAccountRecord; creds: CfCreds }> => {
    const { account, creds } = await requireTeamCreds(ownerId);
    const zone = await getDnsZoneModel(zoneId);
    if (!zone || zone.registrarAccountId !== account.id) throw new Error('Domain not found for this team.');
    return { account, creds };
};
