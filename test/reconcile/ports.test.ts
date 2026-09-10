import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(), execStream: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getOccupiedPorts, getNextFreePorts, doubleCheckPortFree } from '@/reconcile/ports';

const mockExec = execSafe as unknown as Mock;

const NETSTAT = ['Active Internet connections', 'Proto Recv-Q Send-Q Local Address Foreign Address State', 'tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN', 'tcp6 0 0 :::1234 :::* LISTEN'].join('\n');

beforeEach(() => {
    config.production = true;
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

    it('doubleCheckPortFree reflects the nc probe result', async () => {
        mockExec.mockResolvedValueOnce({ out: 'FREE', code: 0 });
        expect(await doubleCheckPortFree(5000)).toBe(true);
        mockExec.mockResolvedValueOnce({ out: 'IN USE', code: 0 });
        expect(await doubleCheckPortFree(5000)).toBe(false);
    });
});

describe('ports (non-production shortcut)', () => {
    it('returns a static occupied list without shelling out', async () => {
        config.production = false;
        expect(await getOccupiedPorts()).toEqual([80, 443, 22, 1234]);
        expect(await doubleCheckPortFree(9999)).toBe(true);
    });
});
