import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { DnsRecord, DnsRecordType, RegistrarProvider } from '@mosaiq/nsm-common/types';
import {
    CfCreds,
    CfDnsRecord,
    CfDnsRecordInput,
    CfRegistrarDomain,
    createDnsRecord as cfCreateDnsRecord,
    deleteDnsRecord as cfDeleteDnsRecord,
    deleteZone as cfDeleteZone,
    getDnsAnalytics as cfGetDnsAnalytics,
    listDnsRecords as cfListDnsRecords,
    listRegistrarDomains as cfListRegistrarDomains,
    listZones as cfListZones,
    setRegistrarAutoRenew as cfSetRegistrarAutoRenew,
    updateDnsRecord as cfUpdateDnsRecord,
} from '@/utils/cloudflare';
import {
    PbCreds,
    PbDnsRecord,
    PbDnsRecordInput,
    createRecord as pbCreateRecord,
    deleteRecord as pbDeleteRecord,
    editRecord as pbEditRecord,
    listAllDomains as pbListAllDomains,
    ping as pbPing,
    retrieveRecords as pbRetrieveRecords,
} from '@/utils/porkbun';
import { getPortReservationIdFromComment, hasDynamicTag } from '@/utils/dnsTags';
import { areaLog, serializeError } from '@/utils/log';

const providerLog = areaLog('registrar');

// === Neutral shapes the DNS/domain stack speaks, regardless of registrar ===

export interface ProviderZone {
    id: string; // Cloudflare zone id, or the domain name itself for registrars without a zone id
    name: string;
    status: string;
    paused: boolean;
}

export interface RegistrarDomainMeta {
    name: string;
    expiresAt?: string;
    autoRenew?: boolean;
    status?: string;
}

// Create/update payload for a single DNS record, provider-neutral. `name` is always the full record
// name (FQDN); adapters convert to a subdomain where their API needs it. `comment` carries NSM's tag
// annotations and maps to the registrar's per-record note field.
export interface DnsWriteInput {
    type: string;
    name: string;
    content?: string;
    ttl?: number;
    proxied?: boolean;
    priority?: number;
    data?: Record<string, unknown>;
    comment?: string;
}

export interface DnsAnalyticsRow {
    queryName: string;
    date: string; // YYYY-MM-DD
    count: number;
}

type ZoneRef = { id: string; name: string };

// The operations the DNS/domain stack needs from a registrar. Resolved once per account via
// getDnsProvider; callers never branch on the concrete provider.
export interface DnsProvider {
    listZones(): Promise<ProviderZone[]>;
    listRecords(zone: ZoneRef): Promise<DnsRecord[]>;
    createRecord(zone: ZoneRef, input: DnsWriteInput): Promise<{ id: string }>;
    updateRecord(zone: ZoneRef, recordId: string, input: Partial<DnsWriteInput>): Promise<void>;
    deleteRecord(zone: ZoneRef, recordId: string): Promise<void>;
    getAnalytics(zoneId: string, since: string, until: string): Promise<DnsAnalyticsRow[]>;
    listRegistrarDomains(): Promise<RegistrarDomainMeta[]>;
    deleteZone(zone: ZoneRef): Promise<void>;
    dashboardUrl(zoneName: string): string | undefined;
    hasRemoteConfig(): boolean;
}

// === Credential extraction ===

export const cloudflareCredsForAccount = (account: RegistrarAccountRecord): CfCreds => ({
    apiToken: account.credentials.apiToken ?? '',
    accountId: account.credentials.accountId ?? '',
});

const porkbunCredsForAccount = (account: RegistrarAccountRecord): PbCreds => ({
    apiKey: account.credentials.apiKey ?? '',
    secretApiKey: account.credentials.secretApiKey ?? '',
});

// === Cloudflare adapter ===

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

const toCfInput = (input: Partial<DnsWriteInput>): Partial<CfDnsRecordInput> => ({
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
    ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
});

const cloudflareProvider = (account: RegistrarAccountRecord): DnsProvider => {
    const creds = cloudflareCredsForAccount(account);
    return {
        listZones: async () => (await cfListZones(creds)).map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused })),
        listRecords: async (zone) => (await cfListDnsRecords(creds, zone.id)).map((r) => cfToRecord(r, zone.id)),
        createRecord: async (zone, input) => {
            const created = await cfCreateDnsRecord(creds, zone.id, toCfInput(input) as CfDnsRecordInput);
            return { id: created.id };
        },
        updateRecord: async (zone, recordId, input) => {
            await cfUpdateDnsRecord(creds, zone.id, recordId, toCfInput(input));
        },
        deleteRecord: async (zone, recordId) => {
            await cfDeleteDnsRecord(creds, zone.id, recordId);
        },
        getAnalytics: (zoneId, since, until) => cfGetDnsAnalytics(creds, zoneId, since, until),
        listRegistrarDomains: async () =>
            (await cfListRegistrarDomains(creds))
                .filter((d): d is CfRegistrarDomain & { name: string } => !!d.name)
                .map((d) => ({ name: d.name, expiresAt: d.expires_at, autoRenew: d.auto_renew, status: d.status })),
        deleteZone: async (zone) => {
            await cfDeleteZone(creds, zone.id);
            // Best-effort: disable registrar auto-renew so a deleted domain stops billing. The registrar
            // beta may not support it; a throw means "disable it in the dashboard" rather than a failure.
            try {
                await cfSetRegistrarAutoRenew(creds, zone.name, false);
            } catch (e) {
                providerLog.warn({ action: 'auto_renew_disable_failed', domainName: zone.name, err: serializeError(e) }, `could not disable auto-renew for ${zone.name}; disable it in the Cloudflare dashboard to stop billing`);
            }
        },
        dashboardUrl: (zoneName) => (creds.accountId ? `https://dash.cloudflare.com/${creds.accountId}/${zoneName}` : undefined),
        hasRemoteConfig: () => !!creds.apiToken,
    };
};

// === Porkbun adapter ===

// Porkbun's minimum (and default) TTL. Cloudflare's "automatic" sentinel (ttl=1) is below it, so
// anything under the minimum is clamped up.
const PB_MIN_TTL = 600;
const pbTtl = (ttl?: number): number => (ttl && ttl >= PB_MIN_TTL ? ttl : PB_MIN_TTL);

// Porkbun's `name` on write is the subdomain only (blank for apex, '*' for wildcard); records are
// read back with the full host. Convert between the FQDN NSM uses and Porkbun's subdomain form.
const toSubdomain = (fqdn: string, zoneName: string): string => {
    const host = fqdn.replace(/\.$/, '');
    if (host.toLowerCase() === zoneName.toLowerCase()) return '';
    const suffix = `.${zoneName.toLowerCase()}`;
    return host.toLowerCase().endsWith(suffix) ? host.slice(0, host.length - suffix.length) : host;
};

// Porkbun models SRV as prio (priority) + content "weight port target"; NSM/Cloudflare model it as a
// structured `data` object. Convert in both directions so the SRV port-reservation feature keeps
// working. Other structured types fall back to their flat `content`.
const pbSrvDataToContent = (data: Record<string, unknown>): { content: string; prio?: number } => {
    const weight = data.weight ?? 0;
    const port = data.port ?? 0;
    const target = data.target ?? '';
    const priority = data.priority;
    return { content: `${weight} ${port} ${target}`.trim(), prio: typeof priority === 'number' ? priority : priority !== undefined ? Number(priority) : undefined };
};

const pbSrvContentToData = (content: string, prio?: string | null): Record<string, unknown> => {
    const [weight, port, ...targetParts] = content.trim().split(/\s+/);
    return {
        priority: prio !== undefined && prio !== null && prio !== '' ? Number(prio) : 0,
        weight: Number(weight) || 0,
        port: Number(port) || 0,
        target: targetParts.join(' '),
    };
};

const pbToRecord = (r: PbDnsRecord, zoneName: string): DnsRecord => {
    const isSrv = r.type.toUpperCase() === 'SRV';
    return {
        id: r.id,
        zoneId: zoneName,
        type: r.type as DnsRecordType,
        name: r.name,
        content: r.content,
        ttl: Number(r.ttl) || PB_MIN_TTL,
        priority: r.prio !== undefined && r.prio !== null && r.prio !== '' ? Number(r.prio) : undefined,
        data: isSrv ? pbSrvContentToData(r.content, r.prio) : undefined,
        comment: r.notes ?? undefined,
        dynamic: hasDynamicTag(r.notes),
        portReservationId: getPortReservationIdFromComment(r.notes),
    };
};

// Build Porkbun's write body from the neutral input. Only fields present on `input` are sent, so a
// partial update (e.g. the dynamic-IP watcher sending just `content`) edits only what it provides.
const toPbInput = (input: Partial<DnsWriteInput>, zoneName: string): Partial<PbDnsRecordInput> => {
    const out: Partial<PbDnsRecordInput> = {};
    if (input.type !== undefined) out.type = input.type;
    if (input.name !== undefined) out.name = toSubdomain(input.name, zoneName);
    if (input.ttl !== undefined) out.ttl = pbTtl(input.ttl);
    if (input.comment !== undefined) out.notes = input.comment;
    if (input.priority !== undefined) out.prio = input.priority;

    const isSrv = (input.type ?? '').toUpperCase() === 'SRV';
    if (isSrv && input.data) {
        const { content, prio } = pbSrvDataToContent(input.data);
        out.content = content;
        if (prio !== undefined) out.prio = prio;
    } else if (input.content !== undefined) {
        out.content = input.content;
    }
    return out;
};

const porkbunProvider = (account: RegistrarAccountRecord): DnsProvider => {
    const creds = porkbunCredsForAccount(account);
    return {
        listZones: async () => (await pbListAllDomains(creds)).map((d) => ({ id: d.domain, name: d.domain, status: (d.status || 'active').toLowerCase(), paused: false })),
        listRecords: async (zone) => (await pbRetrieveRecords(creds, zone.name)).map((r) => pbToRecord(r, zone.name)),
        createRecord: async (zone, input) => pbCreateRecord(creds, zone.name, toPbInput(input, zone.name) as PbDnsRecordInput),
        updateRecord: async (zone, recordId, input) => {
            await pbEditRecord(creds, zone.name, recordId, toPbInput(input, zone.name));
        },
        deleteRecord: async (zone, recordId) => {
            await pbDeleteRecord(creds, zone.name, recordId);
        },
        getAnalytics: async () => [],
        listRegistrarDomains: async () =>
            (await pbListAllDomains(creds)).map((d) => ({
                name: d.domain,
                expiresAt: d.expireDate,
                autoRenew: d.autoRenew === true || d.autoRenew === 1 || d.autoRenew === '1',
                status: d.status,
            })),
        deleteZone: async () => {
            throw new Error('Porkbun domains cannot be deleted from NSM; remove the domain in the Porkbun dashboard.');
        },
        dashboardUrl: (zoneName) => `https://porkbun.com/account/dns/${zoneName}`,
        hasRemoteConfig: () => !!creds.apiKey && !!creds.secretApiKey,
    };
};

// === Resolver ===

export const getDnsProvider = (account: RegistrarAccountRecord): DnsProvider => {
    switch (account.provider) {
        case RegistrarProvider.CLOUDFLARE:
            return cloudflareProvider(account);
        case RegistrarProvider.PORKBUN:
            return porkbunProvider(account);
        default:
            throw new Error(`Unsupported registrar provider: ${account.provider}`);
    }
};

// Resolve the Porkbun account username (non-secret) for use as the shared account id, which also
// validates the submitted credentials.
const porkbunResolveAccount = async (values: Record<string, string>): Promise<string> => {
    const creds: PbCreds = { apiKey: (values.apiKey || '').trim(), secretApiKey: (values.secretApiKey || '').trim() };
    const res = await pbPing(creds);
    const account = (res.account || '').trim();
    if (!account) throw new Error('Porkbun did not return an account for these credentials.');
    return account;
};

// Deterministic shared id for an account so multiple teams entering the same provider account resolve
// to a single stored account (and shared domains). Cloudflare uses its non-secret account id;
// Porkbun uses its account username from /ping (which also validates the keys).
export const resolveAccountId = async (provider: RegistrarProvider, values: Record<string, string>): Promise<string> => {
    if (provider === RegistrarProvider.CLOUDFLARE) return `cloudflare:${(values.accountId || '').trim()}`;
    if (provider === RegistrarProvider.PORKBUN) return `porkbun:${await porkbunResolveAccount(values)}`;
    throw new Error(`Unsupported registrar provider: ${provider}`);
};
