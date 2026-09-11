import { config } from '@/config';
import { execStream, execSafe } from '@/host/exec';
import { sudo } from '@/host/privilege';
import { getAllCertsModel, upsertCertModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { dashboardDomain } from './dashboardIngress';
import { CertRecord } from '@mosaiq/nsm-common/clusterOps';

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

const obtainCert = async (domain: string): Promise<void> => {
    // DNS-01 when configured (recommended); otherwise nginx/HTTP-01 on the leader's ingress.
    const method = config.certbotDnsArgs ? config.certbotDnsArgs : '--nginx';
    const cmd = sudo(`certbot certonly ${method} -d ${domain} --agree-tos --non-interactive --keep-until-expiring`);
    const { out, code } = await execStream(cmd, 1000 * 60 * 3);
    if (code !== 0) {
        console.error(`certbot failed for ${domain}: ${out}`);
        return;
    }
    try {
        // Record only expiry. The PEMs live under /etc/letsencrypt (root-only 0700/0600) and are
        // read by nginx directly; the daemon runs as the unprivileged nsm user and reads notAfter
        // via a sudo-scoped `openssl x509 -enddate`, so it never needs to read the key material.
        const notAfter = await readCertNotAfter(`${config.letsencryptLiveDir}/${domain}/fullchain.pem`);
        const cert: CertRecord = { domain, notAfter };
        await upsertCertModel(cert);
    } catch (e) {
        console.error(`Failed to record cert for ${domain}:`, e);
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
