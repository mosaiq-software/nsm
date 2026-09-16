import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { areaLog } from '@/utils/log';

const portLog = areaLog('ports');

const MIN_PORT = 1025;
const MAX_PORT = 9999;

// Extracts a port from a URL like http://127.0.0.1:3100, defaulting when absent/unparseable.
const portFromUrl = (url: string, fallback: number): number => {
    try {
        const parsed = new URL(url);
        if (parsed.port) return parseInt(parsed.port, 10);
        return parsed.protocol === 'https:' ? 443 : 80;
    } catch {
        return fallback;
    }
};

// Ports NSM's own control plane and observability stack own on a node. These must never be handed
// out to a deployed app: an app that publishes one of these host ports would shadow the daemon (via
// Docker's published-port DNAT) or an infra service, and the collision gets frozen into the app's
// desired deployment. Runtime detection (netstat/nc) is best-effort and racy, so this is a hard,
// static guard on top of it.
export const getReservedPorts = (): Set<number> => {
    return new Set<number>([
        config.apiPort, // nsmd API + dashboard proxy target
        80, // nginx http
        443, // nginx https
        22, // ssh
        8080, // cadvisor
        portFromUrl(config.lokiUrl, 3100),
        portFromUrl(config.prometheusUrl, 9090),
        portFromUrl(config.grafanaUrl, 3000),
    ]);
};

// Node-local ledger of ports allocated to a deployment but not yet bound by its containers. With
// zero-downtime deploys a new generation is allocated ports, then spends a whole build + readiness
// window before it actually listens on them. Socket-based detection (netstat/nc) can't see an
// allocated-but-unbound port, so without this ledger a subsequent deploy on the same node could be
// handed the same port. Reserve at plan time; release on teardown/failure once the port is bound
// (or the generation is gone).
const reservedLedger = new Set<number>();

export const reservePorts = (ports: number[]): void => {
    for (const p of ports) reservedLedger.add(p);
    if (ports.length) portLog.debug({ action: 'ports_reserved', ports }, `reserved ${ports.length} port(s)`);
};

export const releasePorts = (ports: number[]): void => {
    for (const p of ports) reservedLedger.delete(p);
    if (ports.length) portLog.debug({ action: 'ports_released', ports }, `released ${ports.length} port(s)`);
};

export const getLedgerPorts = (): number[] => Array.from(reservedLedger);

export const getNextFreePorts = async (count: number): Promise<number[] | null> => {
    const reservedPorts = getReservedPorts();
    const occupiedPorts = await getOccupiedPorts();
    const freePorts: number[] = [];
    for (let port = MIN_PORT; port <= MAX_PORT; port++) {
        if (reservedPorts.has(port)) continue;
        if (reservedLedger.has(port)) continue; // allocated to an in-flight deploy, not yet bound
        if (!occupiedPorts.includes(port)) {
            const isFree = await doubleCheckPortFree(port);
            if (!isFree) {
                await new Promise((r) => setTimeout(r, 10));
                continue;
            }
            freePorts.push(port);
            if (freePorts.length === count) break;
        }
    }
    if (freePorts.length !== count) {
        portLog.warn({ action: 'port_allocation_failed', requestedCount: count }, `could not allocate ${count} free port(s)`);
        return null;
    }
    // Hold these until the caller binds them, so a concurrent/subsequent plan can't reuse them.
    reservePorts(freePorts);
    portLog.info({ action: 'ports_allocated', requestedCount: count, allocatedPorts: freePorts }, `allocated ${count} free port(s)`);
    return freePorts;
};

// Readiness probe: resolves true once something is listening on the port (optionally answering an
// HTTP path with a non-5xx status), or false if the deadline passes. Inverse of doubleCheckPortFree.
export const waitPortReady = async (port: number, deadlineMs: number, httpPath?: string): Promise<boolean> => {
    if (!config.production) return true;
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
        const listening = !(await doubleCheckPortFree(port));
        if (listening) {
            if (!httpPath) return true;
            if (await httpProbeOk(port, httpPath)) return true;
        }
        await new Promise((r) => setTimeout(r, Math.min(config.readinessIntervalMs, Math.max(0, end - Date.now()))));
    }
    return false;
};

// Best-effort HTTP readiness check against 127.0.0.1:<port><path>. Any non-5xx response (including
// 3xx/4xx) counts as "the app is up and answering"; only 5xx or a connection error is "not ready".
const httpProbeOk = async (port: number, httpPath: string): Promise<boolean> => {
    const path = httpPath.startsWith('/') ? httpPath : `/${httpPath}`;
    const url = `http://127.0.0.1:${port}${path}`;
    const cmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 3 ${url}`;
    try {
        const { out } = await execSafe(cmd, 5000);
        const code = parseInt(out.trim().split(/\s+/).pop() || '0', 10);
        return code > 0 && code < 500;
    } catch {
        return false;
    }
};

export const doubleCheckPortFree = async (port: number): Promise<boolean> => {
    if (!config.production) return true;
    const cmd = `nc -w 2 -z 127.0.0.1 ${port} && echo "IN USE" || echo "FREE"`;
    try {
        const { out } = await execSafe(cmd, 2000);
        return out.includes('FREE');
    } catch (error: any) {
        portLog.error({ action: 'nc_probe_failed', port, err: error?.message }, 'error executing nc command');
        return false;
    }
};

export const getOccupiedPorts = async (): Promise<number[]> => {
    if (!config.production) return [80, 443, 22, 1234];
    const occupiedPorts = new Set<number>();
    try {
        const { out, code } = await execSafe('netstat --numeric-ports -ltu', 5000);
        if (code !== 0) return [];
        const bodyLines = out.split('\n').slice(2);
        for (const line of bodyLines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const portMatch = parts[3].match(/:(\d+)$/);
                if (portMatch) occupiedPorts.add(parseInt(portMatch[1], 10));
            }
        }
    } catch (error: any) {
        portLog.error({ action: 'netstat_failed', err: error?.message }, 'error listing occupied ports');
    }
    return Array.from(occupiedPorts);
};
