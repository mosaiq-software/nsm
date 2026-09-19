import { config, isCloudflareConfigured, isCloudflareRegistrarConfigured } from '@/config';
import { areaLog, serializeError } from '@/utils/log';

const cfLog = areaLog('cloudflare');

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const TIMEOUT_MS = 20000;

// Marker written into a Cloudflare record's `comment` to mark it as NSM-managed dynamic-IP. Keeping
// the flag in the comment (rather than a local table) means it lives in Cloudflare and survives a
// re-sync, so Cloudflare stays authoritative for which records are dynamic.
export const DYNAMIC_TAG = 'nsm-dynamic-ip';

export const hasDynamicTag = (comment?: string | null): boolean => !!comment && comment.includes(DYNAMIC_TAG);
export const addDynamicTag = (comment?: string | null): string => {
    const base = (comment || '').replace(DYNAMIC_TAG, '').trim();
    return base ? `${base} ${DYNAMIC_TAG}` : DYNAMIC_TAG;
};
export const removeDynamicTag = (comment?: string | null): string => (comment || '').replace(DYNAMIC_TAG, '').replace(/\s+/g, ' ').trim();

// Marker binding a record's port (e.g. SRV data.port) to a port reservation. Like DYNAMIC_TAG the
// binding lives in the CF comment (`nsm-port:<reservationId>`) so it survives a re-sync and
// Cloudflare stays authoritative for which records NSM drives.
export const PORT_TAG_PREFIX = 'nsm-port:';
const PORT_TAG_RE = new RegExp(`${PORT_TAG_PREFIX}([A-Za-z0-9_-]+)`);

export const getPortReservationIdFromComment = (comment?: string | null): string | undefined => {
    const m = (comment || '').match(PORT_TAG_RE);
    return m ? m[1] : undefined;
};
export const setPortTag = (comment: string | null | undefined, reservationId: string): string => {
    const base = removePortTag(comment);
    return base ? `${base} ${PORT_TAG_PREFIX}${reservationId}` : `${PORT_TAG_PREFIX}${reservationId}`;
};
export const removePortTag = (comment?: string | null): string => (comment || '').replace(PORT_TAG_RE, '').replace(/\s+/g, ' ').trim();

// Cloudflare wraps every response in { success, errors, messages, result, result_info }.
interface CfEnvelope<T> {
    success: boolean;
    errors: { code: number; message: string }[];
    messages: unknown[];
    result: T;
    result_info?: { page: number; per_page: number; total_count: number; total_pages: number };
}

const cfHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${config.cloudflare.apiToken}`,
    'Content-Type': 'application/json',
});

// Core request helper. Throws with the Cloudflare error messages on a non-success envelope so
// callers can surface an actionable message. `expectEnvelope=false` returns the raw parsed JSON for
// registrar endpoints, whose beta shape does not always use the standard envelope.
const cfRequest = async <T = any>(path: string, init?: { method?: string; body?: unknown; expectEnvelope?: boolean }): Promise<T> => {
    if (!isCloudflareConfigured()) throw new Error('Cloudflare is not configured (CLOUDFLARE_API_TOKEN missing)');
    const method = init?.method || 'GET';
    const res = await fetch(`${CF_API}${path}`, {
        method,
        headers: cfHeaders(),
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
const cfList = async <T = any>(path: string): Promise<T[]> => {
    if (!isCloudflareConfigured()) return [];
    const all: T[] = [];
    for (let page = 1; page <= 50; page++) {
        const sep = path.includes('?') ? '&' : '?';
        const res = await fetch(`${CF_API}${path}${sep}page=${page}&per_page=100`, {
            method: 'GET',
            headers: cfHeaders(),
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

export const listZones = async (): Promise<CfZone[]> => {
    const scope = config.cloudflare.accountId ? `?account.id=${encodeURIComponent(config.cloudflare.accountId)}` : '';
    return cfList<CfZone>(`/zones${scope}`);
};

export const createZone = async (name: string): Promise<CfZone> => {
    const body: Record<string, unknown> = { name, type: 'full' };
    if (config.cloudflare.accountId) body.account = { id: config.cloudflare.accountId };
    return cfRequest<CfZone>('/zones', { method: 'POST', body });
};

export const deleteZone = async (zoneId: string): Promise<void> => {
    await cfRequest(`/zones/${zoneId}`, { method: 'DELETE' });
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

export const listDnsRecords = async (zoneId: string): Promise<CfDnsRecord[]> => cfList<CfDnsRecord>(`/zones/${zoneId}/dns_records`);

export const createDnsRecord = async (zoneId: string, input: CfDnsRecordInput): Promise<CfDnsRecord> => cfRequest<CfDnsRecord>(`/zones/${zoneId}/dns_records`, { method: 'POST', body: input });

export const updateDnsRecord = async (zoneId: string, recordId: string, input: Partial<CfDnsRecordInput>): Promise<CfDnsRecord> =>
    cfRequest<CfDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'PATCH', body: input });

export const deleteDnsRecord = async (zoneId: string, recordId: string): Promise<void> => {
    await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
};

// ===== Registrar (domain search / check / register / manage) =====
export interface CfDomainSuggestion {
    name: string;
    registrable: boolean;
    tier?: 'standard' | 'premium';
    reason?: string;
    pricing?: { currency: string; registration_cost: string; renewal_cost: string };
}

const acct = (): string => {
    if (!isCloudflareRegistrarConfigured()) throw new Error('Cloudflare registrar is not configured (CLOUDFLARE_ACCOUNT_ID missing)');
    return config.cloudflare.accountId;
};

export const searchDomains = async (query: string): Promise<CfDomainSuggestion[]> => {
    const res = await cfRequest<any>(`/accounts/${acct()}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=20`, { expectEnvelope: false });
    return (res?.result?.domains || res?.domains || []) as CfDomainSuggestion[];
};

export const checkDomains = async (domains: string[]): Promise<CfDomainSuggestion[]> => {
    const res = await cfRequest<any>(`/accounts/${acct()}/registrar/domain-check`, { method: 'POST', body: { domains }, expectEnvelope: false });
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
export const registerDomain = async (domain: string, years: number, autoRenew: boolean): Promise<CfRegistrationResult> => {
    const res = await cfRequest<any>(`/accounts/${acct()}/registrar/registrations`, {
        method: 'POST',
        body: { domain_name: domain, years, auto_renew: autoRenew },
        expectEnvelope: false,
    });
    return parseWorkflow(res);
};

export const getRegistrationStatus = async (domain: string): Promise<CfRegistrationResult> => {
    const res = await cfRequest<any>(`/accounts/${acct()}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`, { expectEnvelope: false });
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

export const listRegistrarDomains = async (): Promise<CfRegistrarDomain[]> => {
    const res = await cfRequest<any>(`/accounts/${acct()}/registrar/domains`, { expectEnvelope: false });
    return (res?.result || res?.domains || []) as CfRegistrarDomain[];
};

export const getRegistrarDomain = async (domain: string): Promise<CfRegistrarDomain | null> => {
    try {
        const res = await cfRequest<any>(`/accounts/${acct()}/registrar/domains/${encodeURIComponent(domain)}`, { expectEnvelope: false });
        return (res?.result || res) as CfRegistrarDomain;
    } catch (e: any) {
        cfLog.warn({ action: 'get_registrar_domain_failed', domain, err: serializeError(e) }, `failed to read registrar domain ${domain}`);
        return null;
    }
};

// Best-effort: disable auto-renew so a deleted domain stops billing. The registrar beta may not yet
// support this; callers treat a throw as "instruct the operator to do it in the dashboard".
export const setRegistrarAutoRenew = async (domain: string, autoRenew: boolean): Promise<void> => {
    await cfRequest(`/accounts/${acct()}/registrar/domains/${encodeURIComponent(domain)}`, { method: 'PUT', body: { auto_renew: autoRenew }, expectEnvelope: false });
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
export const getDnsAnalytics = async (zoneId: string, sinceDate: string, untilDate: string): Promise<CfDnsAnalyticsRow[]> => {
    if (!isCloudflareConfigured()) return [];
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
        headers: cfHeaders(),
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
