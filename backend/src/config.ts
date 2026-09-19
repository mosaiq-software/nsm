import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

// Env files live at the repo root and are shared by the daemon and the Vite UI build.
// Precedence (highest first): real shell env > root .env.local > root .env > /etc/nsm/nsm.env.
// dotenv never overwrites an already-set key, so the first file loaded wins among files.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const loadedEnvFiles = [
    dotenv.config({ path: path.join(repoRoot, '.env.local') }),
    dotenv.config({ path: path.join(repoRoot, '.env') }),
    dotenv.config({ path: '/etc/nsm/nsm.env' }),
];

// Every var NSM defines in its own env files. Self-maintaining: adding a var to nsm.env (or a repo
// .env) automatically keeps it out of deployed containers. `parsed` reflects the file contents even
// when systemd already set the key in process.env, so systemd-injected vars are captured too.
export const nsmEnvKeys = new Set<string>(loadedEnvFiles.flatMap((r) => Object.keys(r.parsed ?? {})));
// Safety net for secrets an operator might inject via systemd `Environment=` instead of the file.
for (const k of ['CLUSTER_SECRET', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_PATH']) nsmEnvKeys.add(k);

// Environment for host `docker compose` invocations: process.env with NSM's own vars stripped, so
// the injected workdir `.env` is the single source of truth for Compose interpolation and no NSM
// secret leaks into deployed containers. Docker/system runtime vars (PATH, HOME, DOCKER_*,
// XDG_RUNTIME_DIR, BuildKit flags, SSH_AUTH_SOCK) are preserved.
export const composeChildEnv = (): NodeJS.ProcessEnv => {
    const e = { ...process.env };
    for (const k of nsmEnvKeys) delete e[k];
    return e;
};

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
    githubApp: { appId: string; privateKeyPath: string; installationId: string };
    lokiUrl: string;
    prometheusUrl: string;
    grafanaUrl: string;
    obsLokiPushUrl: string;
    // Web Push (VAPID) credentials. Only the leader signs and sends push messages; when unset,
    // push is disabled and the daemon behaves as before.
    vapidPublicKey: string;
    vapidPrivateKey: string;
    vapidSubject: string;
    version: string;
    commit: string;
    // Zero-downtime (blue-green) deploys: global default (per-project opt-out via Project.zeroDowntime).
    zeroDowntime: boolean;
    // How long the old generation is kept running after nginx has been flipped, so in-flight
    // requests can drain, before it is torn down.
    deployDrainMs: number;
    // Upper bound on the readiness gate for a new generation (healthcheck poll + port/HTTP probe).
    readinessTimeoutMs: number;
    // Poll interval used while waiting for the readiness gate to pass.
    readinessIntervalMs: number;
    // Cloudflare integration (leader-only): DNS record + domain management. Empty token disables the
    // whole feature. accountId is required for registrar (domain search/buy) operations.
    cloudflare: { apiToken: string; accountId: string };
    // How often the leader polls for a public (WAN) IP change to repush dynamic DNS records.
    publicIpPollMinutes: number;
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
    githubApp: {
        appId: process.env.GITHUB_APP_ID || '',
        privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || '/etc/nsm/github-app.pem',
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || '',
    },
    lokiUrl: process.env.LOKI_URL || 'http://127.0.0.1:3100',
    prometheusUrl: process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090',
    grafanaUrl: process.env.GRAFANA_URL || 'http://127.0.0.1:3000',
    obsLokiPushUrl: deriveLokiPush(),
    vapidPublicKey: process.env.NSM_VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: process.env.NSM_VAPID_PRIVATE_KEY || '',
    vapidSubject: process.env.NSM_VAPID_SUBJECT || 'mailto:admin@nsm.local',
    version: readVersion(),
    commit: readGitCommit(),
    // Default ON: only an explicit ZERO_DOWNTIME_DEPLOYS=false opts the whole node out.
    zeroDowntime: process.env.ZERO_DOWNTIME_DEPLOYS !== 'false',
    deployDrainMs: num(process.env.DEPLOY_DRAIN_MS, 10_000),
    readinessTimeoutMs: num(process.env.READINESS_TIMEOUT_MS, 120_000),
    readinessIntervalMs: num(process.env.READINESS_INTERVAL_MS, 2_000),
    cloudflare: {
        apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    },
    publicIpPollMinutes: num(process.env.PUBLIC_IP_POLL_MINUTES, 10),
};

// True when a Cloudflare API token is configured (the DNS/domains feature is enabled at all).
export const isCloudflareConfigured = (): boolean => Boolean(config.cloudflare.apiToken);
// True when registrar (domain search/buy) operations are possible (token + account id).
export const isCloudflareRegistrarConfigured = (): boolean => Boolean(config.cloudflare.apiToken && config.cloudflare.accountId);

export const gitSshKeyPath = (): string => `${config.gitSshKeyDir}/${config.gitSshKeyFile}`;

// True when this node can mint GitHub App installation tokens (App id set + private key present).
// Only the leader holds the key, so this is effectively leader-only in production.
export const isGithubAppConfigured = (): boolean => {
    if (!config.githubApp.appId) return false;
    try {
        return fs.existsSync(config.githubApp.privateKeyPath);
    } catch {
        return false;
    }
};

function readVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch {
        return process.env.NSM_VERSION || '0.0.0';
    }
}

// The git commit of the installed tree. This is the identity self-update converges on (a push to
// main changes it), so it must be the deployed commit rather than the static package.json version.
// Empty when the tree isn't a git checkout (e.g. some dev setups), in which case callers fall back
// to the package.json version.
function readGitCommit(): string {
    try {
        const dir = process.env.NSM_REPO_DIR || '/opt/nsm';
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return '';
    }
}

// Static description of this node. The authoritative current IP comes from getPrimaryIp() at
// registration time; bindAddress is only a fallback.
export const selfNodeInfo = (): NodeInfo => ({
    nodeId: config.nodeId,
    address: config.bindAddress,
    apiPort: config.apiPort,
});
