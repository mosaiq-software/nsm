import { config } from '@/config';
import { execSafe } from '@/host/exec';

const MIN_PORT = 1025;
const MAX_PORT = 9999;

export const getNextFreePorts = async (count: number): Promise<number[] | null> => {
    const occupiedPorts = await getOccupiedPorts();
    const freePorts: number[] = [];
    for (let port = MIN_PORT; port <= MAX_PORT; port++) {
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
    return freePorts.length === count ? freePorts : null;
};

export const doubleCheckPortFree = async (port: number): Promise<boolean> => {
    if (!config.production) return true;
    const cmd = `nc -w 2 -z 127.0.0.1 ${port} && echo "IN USE" || echo "FREE"`;
    try {
        const { out } = await execSafe(cmd, 2000);
        return out.includes('FREE');
    } catch (error) {
        console.error('Error executing nc command', error);
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
    } catch (error) {
        console.error(error);
    }
    return Array.from(occupiedPorts);
};
