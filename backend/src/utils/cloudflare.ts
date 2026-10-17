import { areaLog, serializeError } from '@/utils/log';

const cfLog = areaLog('cloudflare');

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const TIMEOUT_MS = 20000;

// Credentials for a single Cloudflare account. Passed explicitly to every call so NSM can drive
// multiple accounts (one per registrar account) instead of a single global token. `accountId` is
// required only for registrar (domain search/buy) operations.
export interface CfCreds {
    apiToken: string;
    accountId: string;
}

// Cloudflare wraps every response in { success, errors, messages, result, result_info }.
interface CfEnvelope<T> {
    success: boolean;
    errors: { code: number; message: string }[];
    messages: unknown[];
    result: T;
    result_info?: { page: number; per_page: number; total_count: number; total_pages: number };
}

const cfHeaders = (creds: CfCreds): Record<string, string> => ({
    Authorization: `Bearer ${creds.apiToken}`,
    'Content-Type': 'application/json',
});

// Core request helper. Throws with the Cloudflare error messages on a non-success envelope so
// callers can surface an actionable message. `expectEnvelope=false` returns the raw parsed JSON for
// registrar endpoints, whose beta shape does not always use the standard envelope.
const cfRequest = async <T = any>(creds: CfCreds, path: string, init?: { method?: string; body?: unknown; expectEnvelope?: boolean }): Promise<T> => {
    if (!creds.apiToken) throw new Error('Cloudflare is not configured (API token missing)');
    const method = init?.method || 'GET';
    const res = await fetch(`${CF_API}${path}`, {
        method,
        headers: cfHeaders(creds),
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
        parsed = text ? JSON.parse(text) : undefined;
    } catch {
        parsed = undefined;
    }
    if (init?.expectEnvelope === false) {
        if (!res.ok) {
            const msg = parsed?.errors?.map((e: any) => e.message).join('; ') || parsed?.message || text || `${res.status}`;
            throw new Error(`Cloudflare ${method} ${path} failed: ${msg}`);
        }
        return parsed as T;
    }
    const env = parsed as CfEnvelope<T> | undefined;
    if (!res.ok || !env?.success) {
        const msg = env?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || text || `${res.status}`;
        throw new Error(`Cloudflare ${method} ${path} failed: ${msg}`);
    }
    return env.result;
};

// Paginate a list endpoint that uses result_info, accumulating all pages.
const cfList = async <T = any>(creds: CfCreds, path: string): Promise<T[]> => {
    if (!creds.apiToken) return [];
    const all: T[] = [];
    for (let page = 1; page <= 50; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(`${CF_API}${path}${sep}page=${page}&per_page=100`, {
            method: 'GET',
            headers: cfHeaders(creds),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const env = (await res.json()) as CfEnvelope<T[]>;
        if (!res.ok || !env.success) {
            const msg = env?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `${res.status}`;
            throw new Error(`Cloudflare GET ${path} failed: ${msg}`);
        }
        all.push(...(env.result || []));
        const info = env.result_info;
        if (!info || page >= info.total_pages || (env.result || []).length === 0) break;
    }
    return all;
};

// ===== Zones =====
export interface CfZone {
    id: string;
    name: string;
    status: string;
    paused: boolean;
}

export const listZones = async (creds: CfCreds): Promise<CfZone[]> => {
    const scope = creds.accountId ? `?account.id=${encodeURIComponent(creds.accountId)}` : '';
    return cfList<CfZone>(creds, `/zones${scope}`);
};

export const createZone = async (creds: CfCreds, name: string): Promise<CfZone> => {
    const body: Record<string, unknown> = { name, type: 'full' };
    if (creds.accountId) body.account = { id: creds.accountId };
    return cfRequest<CfZone>(creds, '/zones', { method: 'POST', body });
};

export const deleteZone = async (creds: CfCreds, zoneId: string): Promise<void> => {
    await cfRequest(creds, `/zones/${zoneId}`, { method: 'DELETE' });
};

// ===== DNS records =====
export interface CfDnsRecord {
    id: string;
    zone_id: string;
    type: string;
    name: string;
    content: string;
    proxiable?: boolean;
    proxied?: boolean;
    ttl: number;
    priority?: number;
    data?: Record<string, unknown>;
    comment?: string;
}

export interface CfDnsRecordInput {
    type: string;
    name: string;
    content?: string;
    ttl?: number;
    proxied?: boolean;
    priority?: number;
    data?: Record<string, unknown>;
    comment?: string;
}

export const listDnsRecords = async (creds: CfCreds, zoneId: string): Promise<CfDnsRecord[]> => cfList<CfDnsRecord>(creds, `/zones/${zoneId}/dns_records`);

export const createDnsRecord = async (creds: CfCreds, zoneId: string, input: CfDnsRecordInput): Promise<CfDnsRecord> =>
    cfRequest<CfDnsRecord>(creds, `/zones/${zoneId}/dns_records`, { method: 'POST', body: input });

export const updateDnsRecord = async (creds: CfCreds, zoneId: string, recordId: string, input: Partial<CfDnsRecordInput>): Promise<CfDnsRecord> =>
    cfRequest<CfDnsRecord>(creds, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'PATCH', body: input });

export const deleteDnsRecord = async (creds: CfCreds, zoneId: string, recordId: string): Promise<void> => {
    await cfRequest(creds, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
};

// ===== Registrar (domain search / check / register / manage) =====
export interface CfDomainSuggestion {
    name: string;
    registrable: boolean;
    tier?: 'standard' | 'premium';
    reason?: string;
    pricing?: { currency: string; registration_cost: string; renewal_cost: string };
}

const acct = (creds: CfCreds): string => {
    if (!creds.apiToken || !creds.accountId) throw new Error('Cloudflare registrar is not configured (account id missing)');
    return creds.accountId;
};

export const searchDomains = async (creds: CfCreds, query: string): Promise<CfDomainSuggestion[]> => {
    const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=20`, { expectEnvelope: false });
    return (res?.result?.domains || res?.domains || []) as CfDomainSuggestion[];
};

export const checkDomains = async (creds: CfCreds, domains: string[]): Promise<CfDomainSuggestion[]> => {
    const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/domain-check`, { method: 'POST', body: { domains }, expectEnvelope: false });
    return (res?.result?.domains || res?.domains || []) as CfDomainSuggestion[];
};

export interface CfRegistrationResult {
    completed: boolean;
    state?: string; // succeeded | failed | action_required | blocked | pending | in_progress
    error?: { code: string; message: string };
    self?: string;
}

const parseWorkflow = (body: any): CfRegistrationResult => {
    const wf = body?.result?.workflow_status || body?.workflow_status || body?.result || body;
    return {
        completed: !!wf?.completed,
        state: wf?.state,
        error: wf?.error,
        self: wf?.links?.self,
    };
};

// Start a registration. Returns the (possibly still-pending) workflow status; poll
// getRegistrationStatus until terminal.
export const registerDomain = async (creds: CfCreds, domain: string, years: number, autoRenew: boolean): Promise<CfRegistrationResult> => {
    const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/registrations`, {
        method: 'POST',
        body: { domain_name: domain, years, auto_renew: autoRenew },
        expectEnvelope: false,
    });
    return parseWorkflow(res);
};

export const getRegistrationStatus = async (creds: CfCreds, domain: string): Promise<CfRegistrationResult> => {
    const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`, { expectEnvelope: false });
    return parseWorkflow(res);
};

export interface CfRegistrarDomain {
    name?: string;
    id?: string;
    expires_at?: string;
    auto_renew?: boolean;
    status?: string;
    current_registrar?: string;
}

export const listRegistrarDomains = async (creds: CfCreds): Promise<CfRegistrarDomain[]> => {
    const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/domains`, { expectEnvelope: false });
    return (res?.result || res?.domains || []) as CfRegistrarDomain[];
};

export const getRegistrarDomain = async (creds: CfCreds, domain: string): Promise<CfRegistrarDomain | null> => {
    try {
        const res = await cfRequest<any>(creds, `/accounts/${acct(creds)}/registrar/domains/${encodeURIComponent(domain)}`, { expectEnvelope: false });
        return (res?.result || res) as CfRegistrarDomain;
    } catch (e: any) {
        cfLog.warn({ action: 'get_registrar_domain_failed', domain, err: serializeError(e) }, `failed to read registrar domain ${domain}`);
        return null;
    }
};

// Best-effort: disable auto-renew so a deleted domain stops billing. The registrar beta may not yet
// support this; callers treat a throw as "instruct the operator to do it in the dashboard".
export const setRegistrarAutoRenew = async (creds: CfCreds, domain: string, autoRenew: boolean): Promise<void> => {
    await cfRequest(creds, `/accounts/${acct(creds)}/registrar/domains/${encodeURIComponent(domain)}`, { method: 'PUT', body: { auto_renew: autoRenew }, expectEnvelope: false });
};

// ===== DNS analytics (GraphQL) =====
export interface CfDnsAnalyticsRow {
    queryName: string;
    date: string; // YYYY-MM-DD
    count: number;
}

// Daily DNS query counts for a zone over [sinceDate, untilDate], grouped by query name, via
// Cloudflare's GraphQL dnsAnalyticsAdaptiveGroups. Values are inlined (not GraphQL variables) to
// avoid declaring the schema's scalar types; inputs are a zone id and formatted dates we control.
export const getDnsAnalytics = async (creds: CfCreds, zoneId: string, sinceDate: string, untilDate: string): Promise<CfDnsAnalyticsRow[]> => {
    if (!creds.apiToken) return [];
    const query = `{
        viewer {
            zones(filter: { zoneTag: ${JSON.stringify(zoneId)} }) {
                dnsAnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: ${JSON.stringify(sinceDate)}, date_leq: ${JSON.stringify(untilDate)} }, orderBy: [count_DESC]) {
                    count
                    dimensions { queryName date }
                }
            }
        }
    }`;
    const res = await fetch(CF_GRAPHQL, {
        method: 'POST',
        headers: cfHeaders(creds),
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json: any = await res.json().catch(() => undefined);
    if (!res.ok || json?.errors?.length) {
        const msg = json?.errors?.map((e: any) => e.message).join('; ') || `${res.status}`;
        throw new Error(`Cloudflare GraphQL DNS analytics failed: ${msg}`);
    }
    const groups: any[] = json?.data?.viewer?.zones?.[0]?.dnsAnalyticsAdaptiveGroups ?? [];
    return groups.map((g) => ({
        queryName: g.dimensions?.queryName ?? '',
        date: g.dimensions?.date ?? '',
        count: typeof g.count === 'number' ? g.count : 0,
    }));
};
