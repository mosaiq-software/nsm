import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';

const TEMPLATE_PATH = new URL('../../deploy/keepalived.conf.tmpl', import.meta.url);
const KEEPALIVED_CONF = '/etc/keepalived/keepalived.conf';

// Renders keepalived.conf from the template so this node participates in VRRP for the VIP.
// VRRP election is independent of raft leadership (data-plane ingress decoupled from control-plane).
export const ensureKeepalived = async (): Promise<void> => {
    if (!config.production || !config.vip) {
        console.log('[keepalived] skipped (no VIP or not production)');
        return;
    }
    let tmpl = '';
    try {
        tmpl = await fs.readFile(TEMPLATE_PATH, 'utf-8');
    } catch (e) {
        console.error('[keepalived] template missing:', e);
        return;
    }

    // Give each node a slightly different base priority so VRRP has a deterministic ordering.
    const basePriority = 100 + priorityOffset(config.nodeId);
    const rendered = tmpl
        .replaceAll('{{API_PORT}}', String(config.apiPort))
        .replaceAll('{{IFACE}}', config.vrrpIface)
        .replaceAll('{{VRRP_ROUTER_ID}}', String(config.vrrpRouterId))
        .replaceAll('{{BASE_PRIORITY}}', String(basePriority))
        .replaceAll('{{VRRP_PASS}}', config.vrrpPass)
        .replaceAll('{{VIP}}', config.vip);

    try {
        let current = '';
        try {
            current = await fs.readFile(KEEPALIVED_CONF, 'utf-8');
        } catch {
            /* new */
        }
        if (current !== rendered) {
            await fs.mkdir('/etc/keepalived', { recursive: true });
            await fs.writeFile(KEEPALIVED_CONF, rendered);
            await execSafe('systemctl reload keepalived || systemctl restart keepalived', 10000);
            console.log('[keepalived] config updated and reloaded');
        }
    } catch (e) {
        console.error('[keepalived] failed to write config:', e);
    }
};

const priorityOffset = (nodeId: string): number => {
    let h = 0;
    for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) % 50;
    return h;
};
