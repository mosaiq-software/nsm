import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));

import { config } from '@/config';
import { execSafe, execStream } from '@/host/exec';
import { teardownProjectLocal, teardownGenerationLocal } from '@/reconcile/teardown';

const mockStream = execStream as unknown as Mock;
const mockSafe = execSafe as unknown as Mock;

beforeEach(() => {
    config.production = true;
    mockStream.mockClear();
    mockSafe.mockReset().mockResolvedValue({ out: '', code: 0 });
});
afterEach(() => {
    config.production = false;
});

describe('teardownProjectLocal', () => {
    it('runs compose down and the global prune in production', async () => {
        await teardownProjectLocal('proj1');
        expect(mockStream).toHaveBeenCalledTimes(1);
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker system prune -af');
    });

    it('tears down every generation of the project (exact match, no prefix cross-match)', async () => {
        mockSafe.mockImplementation(async (cmd: string) => {
            if (cmd.includes('docker compose ls')) {
                return { out: JSON.stringify([{ Name: 'proj1' }, { Name: 'proj1-g1' }, { Name: 'proj1-g2' }, { Name: 'proj12' }, { Name: 'proj12-g1' }]), code: 0 };
            }
            return { out: '', code: 0 };
        });
        await teardownProjectLocal('proj1');
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker compose -p proj1-g1 down');
        expect(cmd).toContain('docker compose -p proj1-g2 down');
        expect(cmd).toContain('docker system prune -af');
        // "proj12"/"proj12-g1" must NOT be swept up by "proj1".
        expect(cmd).not.toContain('docker compose -p proj12 down');
        expect(cmd).not.toContain('docker compose -p proj12-g1 down');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await teardownProjectLocal('proj1');
        expect(mockStream).not.toHaveBeenCalled();
    });
});

describe('teardownGenerationLocal', () => {
    it('downs a single generation-scoped project and never runs the global prune', async () => {
        await teardownGenerationLocal('proj1', 2);
        expect(mockStream).toHaveBeenCalledTimes(1);
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1-g2 down');
        expect(cmd).not.toContain('docker system prune');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await teardownGenerationLocal('proj1', 2);
        expect(mockStream).not.toHaveBeenCalled();
    });
});
