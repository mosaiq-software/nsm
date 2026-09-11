import { describe, it, expect } from 'vitest';
import { getPrimaryIp } from '@/host/exec';

describe('getPrimaryIp', () => {
    it('resolves to a valid IPv4 address (route source or interface fallback)', async () => {
        const ip = await getPrimaryIp();
        expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    });
});
