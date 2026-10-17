import { areaLog } from '@/utils/log';

const pbLog = areaLog('porkbun');

const PB_API = 'https://api.porkbun.com/api/json/v3';
const TIMEOUT_MS = 20000;
const LIST_PAGE_SIZE = 1000;

// Credentials for a single Porkbun account. Both values are secret; every Porkbun call carries them
// in the JSON body (Porkbun also accepts X-API-Key headers, but the body form is simplest here).
export interface PbCreds {
    apiKey: string;
    secretApiKey: string;
}

// Porkbun wraps every response in { status: 'SUCCESS' | 'ERROR', message?, ... }. A non-SUCCESS
// status (or non-2xx) throws with Porkbun's message so callers can surface an actionable error.
const pbRequest = async <T = any>(creds: PbCreds, path: string, body?: Record<string, unknown>): Promise<T> => {
    if (!creds.apiKey || !creds.secretApiKey) throw new Error('Porkbun is not configured (API keys missing)');
    const res = await fetch(`${PB_API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: creds.apiKey, secretapikey: creds.secretApiKey, ...(body ?? {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
        parsed = text ? JSON.parse(text) : undefined;
    } catch {
        parsed = undefined;
    }
    if (!res.ok || parsed?.status !== 'SUCCESS') {
        const msg = parsed?.message || text || `${res.status}`;
        throw new Error(`Porkbun POST ${path} failed: ${msg}`);
    }
    return parsed as T;
};

// ===== Account / auth =====
export interface PbPingResult {
    status: string;
    yourIp?: string;
    account?: string; // Porkbun account username (non-secret), used as the shared account id
}

export const ping = async (creds: PbCreds): Promise<PbPingResult> => pbRequest<PbPingResult>(creds, '/ping');

// ===== Domains =====
export interface PbDomain {
    domain: string;
    status?: string;
    tld?: string;
    createDate?: string;
    expireDate?: string;
    autoRenew?: string | number | boolean;
    notLocal?: string | number | boolean;
}

// All domains in the account. Porkbun returns up to 1000 per call and paginates by `start` offset.
export const listAllDomains = async (creds: PbCreds): Promise<PbDomain[]> => {
    const all: PbDomain[] = [];
    for (let start = 0; start < 100000; start += LIST_PAGE_SIZE) {
        const res = await pbRequest<{ domains?: PbDomain[] }>(creds, '/domain/listAll', { start: String(start), includeLabels: 'no' });
        const page = res.domains ?? [];
        all.push(...page);
        if (page.length < LIST_PAGE_SIZE) break;
    }
    return all;
};

// ===== DNS records =====
export interface PbDnsRecord {
    id: string;
    name: string; // full host (e.g. www.example.com, or example.com for the apex)
    type: string;
    content: string;
    ttl: string;
    prio?: string | null;
    notes?: string | null;
}

export interface PbDnsRecordInput {
    name?: string; // subdomain only (blank for apex, '*' for wildcard); not the full host
    type: string;
    content: string;
    ttl?: number;
    prio?: number;
    notes?: string;
}

export const retrieveRecords = async (creds: PbCreds, domain: string): Promise<PbDnsRecord[]> => {
    const res = await pbRequest<{ records?: PbDnsRecord[] }>(creds, `/dns/retrieve/${encodeURIComponent(domain)}`);
    return res.records ?? [];
};

export const createRecord = async (creds: PbCreds, domain: string, input: PbDnsRecordInput): Promise<{ id: string }> => {
    const res = await pbRequest<{ id: string | number }>(creds, `/dns/create/${encodeURIComponent(domain)}`, { ...input });
    return { id: String(res.id) };
};

// Porkbun's /dns/edit now edits only the fields sent, so a partial body is accepted here (e.g. a
// dynamic-IP update sending only `content`).
export const editRecord = async (creds: PbCreds, domain: string, id: string, input: Partial<PbDnsRecordInput>): Promise<void> => {
    await pbRequest(creds, `/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`, { ...input });
};

export const deleteRecord = async (creds: PbCreds, domain: string, id: string): Promise<void> => {
    await pbRequest(creds, `/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`);
    pbLog.debug({ action: 'record_deleted', domain, recordId: id }, `deleted Porkbun record ${id}`);
};
