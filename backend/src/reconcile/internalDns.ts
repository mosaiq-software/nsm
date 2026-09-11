import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getAllNodesModel } from '@/persistence/nodePersistence';

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

    await fs.writeFile(path, next);
    const reload = await execSafe('nginx -s reload', 10000);
    if (reload.code !== 0) console.error('[internalDns] nginx reload after hosts change failed:', reload.out);
    return true;
};
