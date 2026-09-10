import * as fs from 'fs/promises';
import { config } from '@/config';
import { execStream, execSafe } from '@/host/exec';
import { getAllCertsModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { cluster } from '@/cluster/node';
import { CertRecord, OpType } from '@mosaiq/nsm-common/clusterOps';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// === All nodes: write replicated cert material to disk so local nginx can terminate TLS ===
export const syncCertsToDisk = async (): Promise<void> => {
    if (!config.production) return;
    const certs = await getAllCertsModel();
    for (const cert of certs) {
        const dir = `${config.letsencryptLiveDir}/${cert.domain}`;
        try {
            await fs.mkdir(dir, { recursive: true });
            await writeIfChanged(`${dir}/fullchain.pem`, cert.fullchainPem);
            await writeIfChanged(`${dir}/privkey.pem`, cert.privkeyPem, 0o600);
        } catch (e) {
            console.error(`Failed writing cert for ${cert.domain}:`, e);
        }
    }
};

const writeIfChanged = async (path: string, contents: string, mode?: number): Promise<void> => {
    let current = '';
    try {
        current = await fs.readFile(path, 'utf-8');
    } catch {
        /* new */
    }
    if (current !== contents) {
        await fs.writeFile(path, contents, mode ? { mode } : undefined);
    }
};

// === Leader only: obtain/renew certs and replicate them into cluster state ===
export const leaderEnsureCerts = async (): Promise<void> => {
    if (!config.production) return;
    const deployments = await getAllDesiredDeploymentsModel();
    const domains = new Set<string>();
    for (const dep of deployments) for (const d of dep.domains || []) domains.add(d);

    const existing = await getAllCertsModel();
    for (const domain of domains) {
        const have = existing.find((c) => c.domain === domain);
        if (have && have.notAfter - Date.now() > THIRTY_DAYS_MS) continue; // still valid
        await obtainAndReplicate(domain);
    }
};

const obtainAndReplicate = async (domain: string): Promise<void> => {
    // DNS-01 (works regardless of which node holds the VIP). Falls back to nginx/HTTP-01 if no DNS args.
    const method = config.certbotDnsArgs ? config.certbotDnsArgs : '--nginx';
    const cmd = `certbot certonly ${method} -d ${domain} --agree-tos --non-interactive --keep-until-expiring`;
    const { out, code } = await execStream(cmd, 1000 * 60 * 3);
    if (code !== 0) {
        console.error(`certbot failed for ${domain}: ${out}`);
        return;
    }
    try {
        const dir = `${config.letsencryptLiveDir}/${domain}`;
        const fullchainPem = await fs.readFile(`${dir}/fullchain.pem`, 'utf-8');
        const privkeyPem = await fs.readFile(`${dir}/privkey.pem`, 'utf-8');
        const notAfter = await readCertNotAfter(`${dir}/fullchain.pem`);
        const cert: CertRecord = { domain, fullchainPem, privkeyPem, notAfter };
        await cluster.propose({ type: OpType.UPSERT_CERT, cert });
    } catch (e) {
        console.error(`Failed to read/replicate cert for ${domain}:`, e);
    }
};

const readCertNotAfter = async (path: string): Promise<number> => {
    const { out, code } = await execSafe(`openssl x509 -enddate -noout -in ${path}`, 5000);
    if (code !== 0) return Date.now() + 60 * 24 * 60 * 60 * 1000;
    const match = out.match(/notAfter=(.*)/);
    if (match) {
        const t = Date.parse(match[1].trim());
        if (!isNaN(t)) return t;
    }
    return Date.now() + 60 * 24 * 60 * 60 * 1000;
};
