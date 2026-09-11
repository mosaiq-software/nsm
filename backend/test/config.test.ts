import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config.ts reads env at import time, so we reset modules and dynamically import per variant.
describe('config', () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => vi.unstubAllEnvs());

    it('parses identity/network values and exposes selfNodeInfo', async () => {
        const { config, selfNodeInfo, gitSshKeyPath } = await import('@/config');
        expect(config.production).toBe(false);
        expect(config.nodeId).toBe('test-node');
        expect(config.apiPort).toBe(16000);
        expect(selfNodeInfo()).toEqual({ nodeId: config.nodeId, address: config.bindAddress, apiPort: config.apiPort });
        expect(gitSshKeyPath()).toBe(`${config.gitSshKeyDir}/${config.gitSshKeyFile}`);
    });

    it('applies boolean/number defaults for invalid values', async () => {
        vi.stubEnv('PRODUCTION', 'true');
        vi.stubEnv('API_PORT', 'not-a-number');
        const { config } = await import('@/config');
        expect(config.production).toBe(true);
        expect(config.apiPort).toBe(1025); // default when unparseable
    });

    it('resolves role from NSM_ROLE (defaults to follower)', async () => {
        vi.stubEnv('NSM_ROLE', '');
        const { config } = await import('@/config');
        expect(config.role).toBe('follower');
        vi.resetModules();
        vi.stubEnv('NSM_ROLE', 'leader');
        const { config: leaderCfg } = await import('@/config');
        expect(leaderCfg.role).toBe('leader');
    });

    it('exposes leaderAddress + internalDomain and derives the Loki push target from the leader host', async () => {
        vi.stubEnv('LEADER_ADDRESS', 'http://192.168.1.50:1025');
        vi.stubEnv('OBS_LOKI_PUSH_URL', '');
        vi.stubEnv('INTERNAL_DOMAIN', 'nsm.internal');
        const { config } = await import('@/config');
        expect(config.leaderAddress).toBe('http://192.168.1.50:1025');
        expect(config.internalDomain).toBe('nsm.internal');
        expect(config.obsLokiPushUrl).toBe('http://192.168.1.50:3100');
    });

    it('honors an explicit OBS_LOKI_PUSH_URL override', async () => {
        vi.stubEnv('OBS_LOKI_PUSH_URL', 'http://loki.example:3100');
        const { config } = await import('@/config');
        expect(config.obsLokiPushUrl).toBe('http://loki.example:3100');
    });
});
