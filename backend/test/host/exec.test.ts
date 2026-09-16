import { describe, it, expect } from 'vitest';
import { execSafe, execStream, getPrimaryIp } from '@/host/exec';

describe('getPrimaryIp', () => {
    it('resolves to a valid IPv4 address (route source or interface fallback)', async () => {
        const ip = await getPrimaryIp();
        expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    });
});

describe('child env isolation', () => {
    it('execStream passes the given env to the child and omits vars not in it', async () => {
        const { out, code } = await execStream('echo "[$FOO][$CLUSTER_SECRET]"', 5000, undefined, { FOO: 'bar', PATH: process.env.PATH });
        expect(code).toBe(0);
        expect(out).toContain('[bar][]');
    });

    it('execSafe passes the given env to the child', async () => {
        const { out, code } = await execSafe('echo "[$FOO]"', 5000, { FOO: 'baz', PATH: process.env.PATH });
        expect(code).toBe(0);
        expect(out).toContain('[baz]');
    });
});
