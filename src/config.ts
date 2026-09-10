import dotenv from 'dotenv';
import * as fs from 'fs';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

dotenv.config();
dotenv.config({ path: '/etc/nsm/nsm.env' });

export interface ClusterFile {
    clusterId: string;
    nodes: NodeInfo[];
    vip: string;
    vrrpRouterId: number;
}

const CLUSTER_FILE_PATH = process.env.CLUSTER_FILE_PATH || '/etc/nsm/cluster.json';

export interface NsmConfig {
    production: boolean;
    nodeId: string;
    bindAddress: string;
    raftPort: number;
    apiPort: number;
    vip: string;
    vrrpRouterId: number;
    vrrpPass: string;
    vrrpIface: string;
    clusterSecret: string;
    bootstrapMode: string; // 'init' | ''
    databaseDir: string;
    databaseName: string;
    raftDataDir: string;
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
    version: string;
}

const bool = (v: string | undefined) => v === 'true';
const num = (v: string | undefined, d: number) => (v && !isNaN(Number(v)) ? Number(v) : d);

export const config: NsmConfig = {
    production: bool(process.env.PRODUCTION),
    nodeId: process.env.NODE_ID || 'node-local',
    bindAddress: process.env.BIND_ADDRESS || '127.0.0.1',
    raftPort: num(process.env.RAFT_PORT, 1027),
    apiPort: num(process.env.API_PORT, 1025),
    vip: process.env.VIP || '',
    vrrpRouterId: num(process.env.VRRP_ROUTER_ID, 51),
    vrrpPass: process.env.VRRP_PASS || 'changeme',
    vrrpIface: process.env.VRRP_IFACE || 'eth0',
    clusterSecret: process.env.CLUSTER_SECRET || 'insecure-dev-secret',
    bootstrapMode: process.env.NSM_BOOTSTRAP || '',
    databaseDir: process.env.DATABASE_DIR || '/var/lib/nsm',
    databaseName: process.env.DATABASE_NAME || 'nsmdb.sqlite',
    raftDataDir: process.env.RAFT_DATA_DIR || '/var/lib/nsm/raft',
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

export const loadClusterFile = (): ClusterFile => {
    try {
        const raw = fs.readFileSync(CLUSTER_FILE_PATH, 'utf-8');
        return JSON.parse(raw) as ClusterFile;
    } catch {
        // Fallback: single-node cluster consisting of just this node.
        return {
            clusterId: 'default',
            nodes: [{ nodeId: config.nodeId, address: config.bindAddress, raftPort: config.raftPort, apiPort: config.apiPort }],
            vip: config.vip,
            vrrpRouterId: config.vrrpRouterId,
        };
    }
};

export const saveClusterFile = (cf: ClusterFile): void => {
    try {
        fs.mkdirSync(CLUSTER_FILE_PATH.replace(/\/[^/]*$/, ''), { recursive: true });
        fs.writeFileSync(CLUSTER_FILE_PATH, JSON.stringify(cf, null, 2));
    } catch (e) {
        console.error('Failed to persist cluster file:', e);
    }
};

export const selfNodeInfo = (): NodeInfo => ({
    nodeId: config.nodeId,
    address: config.bindAddress,
    raftPort: config.raftPort,
    apiPort: config.apiPort,
});
