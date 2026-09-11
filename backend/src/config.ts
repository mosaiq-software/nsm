import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

// Env files live at the repo root and are shared by the daemon and the Vite UI build.
// Precedence (highest first): real shell env > root .env.local > root .env > /etc/nsm/nsm.env.
// dotenv never overwrites an already-set key, so the first file loaded wins among files.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
dotenv.config({ path: path.join(repoRoot, '.env.local') });
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: '/etc/nsm/nsm.env' });

export interface NsmConfig {
    production: boolean;
    nodeId: string;
    role: 'leader' | 'follower';
    bindAddress: string;
    apiPort: number;
    leaderAddress: string;
    publicUrl: string;
    internalDomain: string;
    clusterSecret: string;
    databaseDir: string;
    databaseName: string;
    repoSandboxPath: string;
    deploymentPath: string;
    persistentPath: string;
    nginxConfDir: string;
    letsencryptLiveDir: string;
    wwwPath: string;
    certbotDnsArgs: string;
    nsmRepoDir: string;
    gitSshKeyDir: string;
    gitSshKeyFile: string;
    lokiUrl: string;
    prometheusUrl: string;
    grafanaUrl: string;
    obsLokiPushUrl: string;
    version: string;
}

const bool = (v: string | undefined) => v === 'true';
const num = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);

const apiPort = num(process.env.API_PORT, 1025);
const leaderAddress = process.env.LEADER_ADDRESS || `http://127.0.0.1:${apiPort}`;

// The externally reachable base URL of this node, used to template the served install.sh and the
// copy-paste join command. Derived from trusted server config only (never request headers) so it
// cannot be poisoned into the root-executed installer.
const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1';
const publicUrl = process.env.NSM_PUBLIC_URL || process.env.API_URL || process.env.FRONTEND_URL || `http://${bindAddress}:${apiPort}`;

// Default the Loki push target to the leader host on the standard Loki port.
const deriveLokiPush = (): string => {
    if (process.env.OBS_LOKI_PUSH_URL) return process.env.OBS_LOKI_PUSH_URL;
    try {
        const host = new URL(leaderAddress).hostname;
        return `http://${host}:3100`;
    } catch {
        return 'http://127.0.0.1:3100';
    }
};

export const config: NsmConfig = {
    production: bool(process.env.PRODUCTION),
    nodeId: process.env.NODE_ID || 'node-local',
    role: (process.env.NSM_ROLE as 'leader' | 'follower') || 'follower',
    bindAddress,
    apiPort,
    leaderAddress,
    publicUrl,
    internalDomain: process.env.INTERNAL_DOMAIN || 'nsm.internal',
    clusterSecret: process.env.CLUSTER_SECRET || 'insecure-dev-secret',
    databaseDir: process.env.DATABASE_DIR || '/var/lib/nsm',
    databaseName: process.env.DATABASE_NAME || 'nsmdb.sqlite',
    repoSandboxPath: process.env.REPO_SANDBOX_PATH || '/var/lib/nsm/sandbox',
    deploymentPath: process.env.DEPLOYMENT_PATH || '/nsm/apps',
    persistentPath: process.env.PERSISTENT_PATH || '/var/lib/nsm/persistent',
    nginxConfDir: process.env.NGINX_CONF_DIR || '/etc/nsm/nginx',
    letsencryptLiveDir: process.env.LETSENCRYPT_LIVE_DIR || '/etc/letsencrypt/live',
    wwwPath: process.env.NSM_WWW_PATH || '/var/lib/nsm/www',
    certbotDnsArgs: process.env.CERTBOT_DNS_ARGS || '',
    nsmRepoDir: process.env.NSM_REPO_DIR || '/opt/nsm',
    gitSshKeyDir: process.env.GIT_SSH_KEY_DIR || '/etc/nsm/.ssh',
    gitSshKeyFile: process.env.GIT_SSH_KEY_FILE || 'id_ed25519',
    lokiUrl: process.env.LOKI_URL || 'http://127.0.0.1:3100',
    prometheusUrl: process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090',
    grafanaUrl: process.env.GRAFANA_URL || 'http://127.0.0.1:3000',
    obsLokiPushUrl: deriveLokiPush(),
    version: readVersion(),
};

export const gitSshKeyPath = (): string => `${config.gitSshKeyDir}/${config.gitSshKeyFile}`;

function readVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch {
        return process.env.NSM_VERSION || '0.0.0';
    }
}

// Static description of this node. The authoritative current IP comes from getPrimaryIp() at
// registration time; bindAddress is only a fallback.
export const selfNodeInfo = (): NodeInfo => ({
    nodeId: config.nodeId,
    address: config.bindAddress,
    apiPort: config.apiPort,
});
