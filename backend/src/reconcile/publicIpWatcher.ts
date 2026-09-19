import { cluster } from '@/cluster/node';
import { isCloudflareConfigured } from '@/config';
import { getMeta, setMeta } from '@/persistence/clusterMetaPersistence';
import { getAllDynamicRecordsModel } from '@/persistence/dnsRecordPersistence';
import { updateDnsRecord } from '@/utils/cloudflare';
import { syncZoneRecords } from '@/reconcile/cloudflareSync';
import { areaLog } from '@/utils/log';

const ipLog = areaLog('cloudflare');

const PUBLIC_IP4_META_KEY = 'publicIpv4';
const PUBLIC_IP6_META_KEY = 'publicIpv6';
const FETCH_TIMEOUT_MS = 8000;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/;

const fetchText = async (url: string): Promise<string | null> => {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return null;
        return (await res.text()).trim();
    } catch {
        return null;
    }
};

// The `ip=` line out of a Cloudflare cdn-cgi/trace response.
const parseTraceIp = (body: string | null): string | null => {
    if (!body) return null;
    const m = body.match(/^ip=(.+)$/m);
    return m ? m[1].trim() : null;
};

// Current public IPv4. Primary source is ipify (always IPv4); Cloudflare trace is the fallback but
// only accepted if it is actually an IPv4 address (trace may return IPv6).
export const detectPublicIpv4 = async (): Promise<string | null> => {
    const ipify = await fetchText('https://api.ipify.org');
    if (ipify && IPV4_RE.test(ipify)) return ipify;
    const trace = parseTraceIp(await fetchText('https://www.cloudflare.com/cdn-cgi/trace'));
    return trace && IPV4_RE.test(trace) ? trace : null;
};

// Current public IPv6 (best-effort; null when the host has no IPv6 egress).
export const detectPublicIpv6 = async (): Promise<string | null> => {
    const ipify = await fetchText('https://api6.ipify.org');
    return ipify && IPV6_RE.test(ipify) ? ipify : null;
};

export interface PublicIpCheckResult {
    ip: string | null; // best-known public IPv4 after the check
    changed: boolean; // whether any dynamic record was repushed
}

// Leader-only: detect the current public IP(s) and, when they changed, repush every dynamic-tagged
// A (IPv4) / AAAA (IPv6) record to Cloudflare, then refresh the affected zones' caches. Returns the
// resulting IPv4 and whether anything changed so callers (cron and the manual button) can report it.
export const checkPublicIp = async (): Promise<PublicIpCheckResult> => {
    if (!cluster.isLeader() || !isCloudflareConfigured()) return { ip: null, changed: false };
    try {
        const dynamicRecords = await getAllDynamicRecordsModel();
        const lastV4 = await getMeta(PUBLIC_IP4_META_KEY);
        const lastV6 = await getMeta(PUBLIC_IP6_META_KEY);
        if (dynamicRecords.length === 0) return { ip: lastV4 || (await detectPublicIpv4()), changed: false };

        const needV4 = dynamicRecords.some((r) => r.type === 'A');
        const needV6 = dynamicRecords.some((r) => r.type === 'AAAA');
        const ipv4 = needV4 ? await detectPublicIpv4() : null;
        const ipv6 = needV6 ? await detectPublicIpv6() : null;

        const v4Changed = !!ipv4 && ipv4 !== lastV4;
        const v6Changed = !!ipv6 && ipv6 !== lastV6;
        if (!v4Changed && !v6Changed) return { ip: ipv4 || lastV4, changed: false };

        const touchedZones = new Set<string>();
        for (const rec of dynamicRecords) {
            const target = rec.type === 'A' ? (v4Changed ? ipv4 : null) : rec.type === 'AAAA' ? (v6Changed ? ipv6 : null) : null;
            if (!target) continue;
            try {
                await updateDnsRecord(rec.zoneId, rec.id, { content: target });
                touchedZones.add(rec.zoneId);
                ipLog.info({ action: 'dynamic_record_updated', recordId: rec.id, name: rec.name, type: rec.type, ip: target }, `updated dynamic ${rec.type} ${rec.name} -> ${target}`);
            } catch (e: any) {
                ipLog.error({ action: 'dynamic_record_update_failed', recordId: rec.id, err: e?.message }, `failed to update dynamic record ${rec.name}`);
            }
        }

        if (v4Changed && ipv4) await setMeta(PUBLIC_IP4_META_KEY, ipv4);
        if (v6Changed && ipv6) await setMeta(PUBLIC_IP6_META_KEY, ipv6);
        for (const zoneId of touchedZones) await syncZoneRecords(zoneId);
        return { ip: ipv4 || lastV4, changed: touchedZones.size > 0 };
    } catch (e: any) {
        ipLog.error({ action: 'public_ip_check_failed', err: e?.message }, 'public IP check failed');
        return { ip: null, changed: false };
    }
};

// The last public IPv4 NSM detected (for display on the domains UI). Falls back to a live detect.
export const getKnownPublicIp = async (): Promise<string | null> => {
    return (await getMeta(PUBLIC_IP4_META_KEY)) || (await detectPublicIpv4());
};
