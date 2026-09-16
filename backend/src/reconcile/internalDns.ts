import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { sudo, execWithInput } from '@/host/privilege';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { areaLog } from '@/utils/log';

const dnsLog = areaLog('internalDns');

const BEGIN = '# BEGIN NSM-managed';
const END = '# END NSM-managed';
// Overridable for tests; production always targets the real hosts file.
const hostsPath = (): string => process.env.NSM_HOSTS_PATH || '/etc/hosts';

export const buildManagedBlock = (nodes: { nodeId: string; address: string }[], domain: string): string => {
    const lines = nodes.map((n) => `${n.address} ${n.nodeId}.${domain}`);
    return `${BEGIN}\n${lines.join('\n')}\n${END}\n`;
};

// Rewrite the managed block in /etc/hosts mapping <nodeId>.<internalDomain> -> current IP for
// every node in the registry, preserving all other hosts entries. Reloads nginx (so statically
// resolved upstream hostnames pick up new IPs) only when the block actually changes. Leader only.
export const refreshInternalHosts = async (): Promise<boolean> => {
    if (!config.production) return false;
    const path = hostsPath();
    const nodes = await getAllNodesModel();
    const block = buildManagedBlock(nodes, config.internalDomain);

    let current = '';
    try {
        current = await fs.readFile(path, 'utf-8');
    } catch {
        /* hosts file unexpectedly missing; we'll create it */
    }
    const without = current.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, 'g'), '');
    const next = `${without.trimEnd()}\n${block}`;
    if (next === current) return false;

    // As the unprivileged nsm user we cannot write /etc/hosts directly, so pipe the new contents
    // to the sudo-scoped nsm-apply-hosts helper. Tests/dev point NSM_HOSTS_PATH at a writable temp
    // file and take the direct fs path.
    if (process.env.NSM_HOSTS_PATH) {
        await fs.writeFile(path, next);
    } else {
        const write = await execWithInput(sudo('/usr/local/sbin/nsm-apply-hosts'), next, 10000);
        if (write.code !== 0) dnsLog.error({ action: 'hosts_write_failed', out: write.out }, 'failed to write /etc/hosts');
    }
    dnsLog.info({ action: 'internal_hosts_refreshed', nodeCount: nodes.length }, `rewrote internal hosts block for ${nodes.length} node(s)`);
    const reload = await execSafe(sudo('nginx -s reload'), 10000);
    if (reload.code !== 0) dnsLog.error({ action: 'nginx_reload_failed', out: reload.out }, 'nginx reload after hosts change failed');
    return true;
};
