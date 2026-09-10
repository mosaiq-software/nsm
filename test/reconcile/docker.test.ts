import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(), execStream: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { listContainerData } from '@/reconcile/docker';

const mockExec = execSafe as unknown as Mock;

beforeEach(() => {
    config.production = true;
    mockExec.mockReset();
});
afterEach(() => {
    config.production = false;
});

describe('listContainerData', () => {
    it('parses JSON lines and splits the Labels string into a map', async () => {
        const lines = [JSON.stringify({ ID: 'c1', Names: 'web', State: 'running', Labels: 'nsm.projectId=p1,nsm.service=web' }), 'not-json-noise', '{ broken', JSON.stringify({ ID: 'c2', Names: 'db', State: 'exited', Labels: '' })].join('\n');
        mockExec.mockResolvedValue({ out: lines, code: 0 });
        const data = await listContainerData();
        expect(data).toHaveLength(2);
        expect(data[0].Labels['nsm.projectId']).toBe('p1');
        expect(data[0].Labels['nsm.service']).toBe('web');
        expect(data[1].Labels).toEqual({});
    });

    it('throws when docker exits non-zero', async () => {
        mockExec.mockResolvedValue({ out: 'boom', code: 1 });
        await expect(listContainerData()).rejects.toThrow(/Error listing containers/);
    });

    it('returns an empty list in non-production without shelling out', async () => {
        config.production = false;
        expect(await listContainerData()).toEqual([]);
        expect(mockExec).not.toHaveBeenCalled();
    });
});
