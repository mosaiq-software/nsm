import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(), execStream: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getOccupiedPorts, getNextFreePorts, doubleCheckPortFree, getReservedPorts, releasePorts, getLedgerPorts, waitPortReady } from '@/reconcile/ports';

const mockExec = execSafe as unknown as Mock;

const NETSTAT = ['Active Internet connections', 'Proto Recv-Q Send-Q Local Address Foreign Address State', 'tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN', 'tcp6 0 0 :::1234 :::* LISTEN'].join('\n');

beforeEach(() => {
    config.production = true;
    releasePorts(getLedgerPorts()); // the ledger is module-level; reset it between tests
    mockExec.mockReset();
    mockExec.mockImplementation(async (cmd: string) => {
        if (cmd.includes('netstat')) return { out: NETSTAT, code: 0 };
        if (cmd.startsWith('nc ')) return { out: 'FREE', code: 0 };
        return { out: '', code: 0 };
    });
});
afterEach(() => {
    config.production = false;
});

describe('ports (production)', () => {
    it('parses occupied ports from netstat', async () => {
        const occupied = await getOccupiedPorts();
        expect(occupied.sort((a, b) => a - b)).toEqual([80, 1234]);
    });

    it('returns the first N free ports not in the occupied set', async () => {
        const free = await getNextFreePorts(2);
        expect(free).toEqual([1025, 1026]);
    });

    it('never allocates the reserved API port even when it is otherwise free', async () => {
        const original = config.apiPort;
        config.apiPort = 1025; // pin the control-plane port into the allocatable range
        try {
            const free = await getNextFreePorts(2);
            expect(free).toEqual([1026, 1027]);
        } finally {
            config.apiPort = original;
        }
    });

    it('never hands out reserved control-plane or observability ports', async () => {
        const reserved = getReservedPorts();
        expect(reserved.has(config.apiPort)).toBe(true);
        expect(reserved.has(3000)).toBe(true);
        expect(reserved.has(3100)).toBe(true);
        expect(reserved.has(9090)).toBe(true);
        expect(reserved.has(8080)).toBe(true);

        // Even when nc claims every port is free, the allocator must skip reserved ports.
        const free = await getNextFreePorts(50);
        expect(free).not.toBeNull();
        for (const port of free!) {
            expect(reserved.has(port)).toBe(false);
        }
    });

    it('doubleCheckPortFree reflects the nc probe result', async () => {
        mockExec.mockResolvedValueOnce({ out: 'FREE', code: 0 });
        expect(await doubleCheckPortFree(5000)).toBe(true);
        mockExec.mockResolvedValueOnce({ out: 'IN USE', code: 0 });
        expect(await doubleCheckPortFree(5000)).toBe(false);
    });

    it('reserves allocated ports so a subsequent plan cannot reuse an allocated-but-unbound port', async () => {
        const first = await getNextFreePorts(2);
        expect(first).toEqual([1025, 1026]);
        // Ledger now holds 1025/1026 even though nc reports them free (not yet bound).
        const second = await getNextFreePorts(2);
        expect(second).toEqual([1027, 1028]);
        // Releasing frees them for reuse.
        releasePorts([1025, 1026]);
        const third = await getNextFreePorts(1);
        expect(third).toEqual([1025]);
    });

    it('waitPortReady resolves true once the port is listening (nc reports IN USE)', async () => {
        mockExec.mockImplementation(async (cmd: string) => (cmd.startsWith('nc ') ? { out: 'IN USE', code: 0 } : { out: '', code: 0 }));
        expect(await waitPortReady(6000, 1000)).toBe(true);
    });

    it('waitPortReady resolves false when the port never starts listening before the deadline', async () => {
        mockExec.mockImplementation(async (cmd: string) => (cmd.startsWith('nc ') ? { out: 'FREE', code: 0 } : { out: '', code: 0 }));
        expect(await waitPortReady(6000, 30)).toBe(false);
    });

    it('waitPortReady also requires a non-5xx HTTP response when a readiness path is given', async () => {
        mockExec.mockImplementation(async (cmd: string) => {
            if (cmd.startsWith('nc ')) return { out: 'IN USE', code: 0 };
            if (cmd.includes('curl')) return { out: '200', code: 0 };
            return { out: '', code: 0 };
        });
        expect(await waitPortReady(6000, 1000, '/healthz')).toBe(true);

        mockExec.mockImplementation(async (cmd: string) => {
            if (cmd.startsWith('nc ')) return { out: 'IN USE', code: 0 };
            if (cmd.includes('curl')) return { out: '503', code: 0 };
            return { out: '', code: 0 };
        });
        expect(await waitPortReady(6000, 30, '/healthz')).toBe(false);
    });
});

describe('ports (non-production shortcut)', () => {
    it('returns a static occupied list without shelling out', async () => {
        config.production = false;
        expect(await getOccupiedPorts()).toEqual([80, 443, 22, 1234]);
        expect(await doubleCheckPortFree(9999)).toBe(true);
    });
});
