import * as fs from 'fs/promises';
import { config } from '@/config';
import { execStream, execSafe } from '@/host/exec';
import { sudo } from '@/host/privilege';
import { deleteCertModel, getAllCertsModel, upsertCertModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { dashboardDomain } from './dashboardIngress';
import { getAccountForDomain } from '@/controllers/registrarController';
import { cloudflareCredsForAccount } from '@/registrar/provider';
import { RegistrarProvider } from '@mosaiq/nsm-common/types';
import { CertRecord } from '@mosaiq/nsm-common/clusterOps';
import { areaLog, serializeError } from '@/utils/log';

const certLog = areaLog('certs');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// === Leader only: obtain/renew certs for every domain in the desired state ===
// The leader is the single TLS ingress, so certs live only on the leader (certbot writes them to
// LETSENCRYPT_LIVE_DIR which nginx reads directly). We keep a small local DB record purely to
// track expiry cheaply between renewals.
export const leaderEnsureCerts = async (): Promise<void> => {
    if (!config.production) return;
    const deployments = await getAllDesiredDeploymentsModel();
    const domains = new Set<string>();
    for (const dep of deployments) for (const d of dep.domains || []) domains.add(d);
    // The leader also fronts its own management dashboard over TLS.
    const dashDomain = dashboardDomain();
    if (dashDomain) domains.add(dashDomain);

    const existing = await getAllCertsModel();
    for (const domain of domains) {
        const have = existing.find((c) => c.domain === domain);
        if (have && have.notAfter - Date.now() > THIRTY_DAYS_MS) continue; // still valid
        await obtainCert(domain);
    }
};

// Back off per-domain after a failure so a domain that can't be issued (bad DNS, LE rate limit,
// etc.) doesn't get retried on every reconcile tick and exhaust Let's Encrypt's rate limits.
const CERT_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const lastFailedAt = new Map<string, number>();

// Materialize a certbot cloudflare DNS plugin credentials file for the given registrar account and
// return the certbot DNS-01 args that use it, or null when the domain has no Cloudflare account (so
// the caller falls back to the global env args or HTTP-01). The file is written 0600 under the
// nsm-owned registrarCredsDir; certbot runs via sudo (root) and can read it.
const dnsArgsForDomain = async (domain: string): Promise<string | null> => {
    try {
        const account = await getAccountForDomain(domain);
        if (!account || account.provider !== RegistrarProvider.CLOUDFLARE) return null;
        const creds = cloudflareCredsForAccount(account);
        if (!creds.apiToken) return null;
        const safeId = account.id.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${config.registrarCredsDir}/${safeId}.ini`;
        await fs.writeFile(path, `dns_cloudflare_api_token = ${creds.apiToken}\n`, { mode: 0o600 });
        await fs.chmod(path, 0o600);
        return `--dns-cloudflare --dns-cloudflare-credentials ${path} --dns-cloudflare-propagation-seconds 30`;
    } catch (e) {
        // Degraded fallback: if we can't resolve the registrar account for this domain, fall back to
        // the global env DNS args / HTTP-01 rather than failing issuance.
        certLog.debug({ action: 'cert_dns_creds_unresolved', domain, err: serializeError(e) }, `could not resolve registrar DNS creds for ${domain}`);
        return null;
    }
};

const obtainCert = async (domain: string): Promise<void> => {
    const failedAt = lastFailedAt.get(domain);
    if (failedAt && Date.now() - failedAt < CERT_RETRY_COOLDOWN_MS) return;

    // Prefer DNS-01 with the Cloudflare account that owns the domain's zone; fall back to any global
    // env DNS args, and finally to nginx/HTTP-01 on the leader's ingress.
    const perAccountDnsArgs = await dnsArgsForDomain(domain);
    const method = perAccountDnsArgs ? perAccountDnsArgs : config.certbotDnsArgs ? config.certbotDnsArgs : '--nginx';
    // Pin --cert-name and --key-type so certbot reuses one deterministic lineage per domain (whose
    // live dir matches the path nginx references) instead of auto-selecting a stray lineage, and so
    // it never blocks in --non-interactive mode asking to confirm an ECDSA<->RSA key-type change.
    const cmd = sudo(
        `certbot certonly ${method} -d ${domain} --cert-name ${domain} --key-type ecdsa --agree-tos --non-interactive --keep-until-expiring`,
    );
    certLog.info({ action: 'cert_issuance_started', domain, method: perAccountDnsArgs || config.certbotDnsArgs ? 'dns' : 'nginx' }, `obtaining cert for ${domain}`);
    const { out, code } = await execStream(cmd, 1000 * 60 * 3);
    if (code !== 0) {
        lastFailedAt.set(domain, Date.now());
        certLog.error({ action: 'cert_issuance_failed', domain, exitCode: code, out }, `certbot failed for ${domain}`);
        return;
    }
    lastFailedAt.delete(domain);
    try {
        // Record only expiry. The PEMs live under /etc/letsencrypt (root-only 0700/0600) and are
        // read by nginx directly; the daemon runs as the unprivileged nsm user and reads notAfter
        // via a sudo-scoped `openssl x509 -enddate`, so it never needs to read the key material.
        const notAfter = await readCertNotAfter(`${config.letsencryptLiveDir}/${domain}/fullchain.pem`);
        const cert: CertRecord = { domain, notAfter };
        await upsertCertModel(cert);
        certLog.info({ action: 'cert_issued', domain, notAfter }, `issued/renewed cert for ${domain}`);
    } catch (e: any) {
        certLog.error({ action: 'cert_record_failed', domain, err: serializeError(e) }, `failed to record cert for ${domain}`);
    }
};

// === Leader only: remove certs for a deleted project's domains ===
// Deletes each domain's certbot lineage (its live dir under LETSENCRYPT_LIVE_DIR, which nginx reads)
// and drops the local expiry record. Best-effort per domain so one failure never blocks the rest.
export const removeCertsForDomains = async (domains: string[]): Promise<void> => {
    if (!config.production) return;
    for (const domain of domains) {
        const cmd = sudo(`certbot delete --cert-name ${domain} --non-interactive`);
        const { out, code } = await execStream(cmd, 1000 * 60);
        if (code !== 0) certLog.warn({ action: 'cert_delete_nonzero', domain, exitCode: code, out }, `certbot delete failed for ${domain}`);
        else certLog.info({ action: 'cert_deleted', domain }, `deleted cert for ${domain}`);
        lastFailedAt.delete(domain);
        try {
            await deleteCertModel(domain);
        } catch (e: any) {
            certLog.error({ action: 'cert_record_delete_failed', domain, err: serializeError(e) }, `failed to remove cert record for ${domain}`);
        }
    }
};

const readCertNotAfter = async (path: string): Promise<number> => {
    const { out, code } = await execSafe(sudo(`openssl x509 -enddate -noout -in ${path}`), 5000);
    if (code !== 0) return Date.now() + 60 * 24 * 60 * 60 * 1000;
    const match = out.match(/notAfter=(.*)/);
    if (match) {
        const t = Date.parse(match[1].trim());
        if (!isNaN(t)) return t;
    }
    return Date.now() + 60 * 24 * 60 * 60 * 1000;
};
