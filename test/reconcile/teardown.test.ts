import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { teardownProjectLocal } from '@/reconcile/teardown';

const mockStream = execStream as unknown as Mock;

beforeEach(() => {
    config.production = true;
    mockStream.mockClear();
});
afterEach(() => {
    config.production = false;
});

describe('teardownProjectLocal', () => {
    it('runs compose down and prune in production', async () => {
        await teardownProjectLocal('proj1');
        expect(mockStream).toHaveBeenCalledTimes(1);
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker system prune -af');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await teardownProjectLocal('proj1');
        expect(mockStream).not.toHaveBeenCalled();
    });
});
