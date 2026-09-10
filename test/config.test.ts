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
        expect(selfNodeInfo()).toEqual({ nodeId: config.nodeId, address: config.bindAddress, raftPort: config.raftPort, apiPort: config.apiPort });
        expect(gitSshKeyPath()).toBe(`${config.gitSshKeyDir}/${config.gitSshKeyFile}`);
    });

    it('applies boolean/number defaults for invalid values', async () => {
        vi.stubEnv('PRODUCTION', 'true');
        vi.stubEnv('API_PORT', 'not-a-number');
        const { config } = await import('@/config');
        expect(config.production).toBe(true);
        expect(config.apiPort).toBe(1025); // default when unparseable
    });

    it('loadClusterFile falls back to a single-node cluster when the file is missing', async () => {
        vi.stubEnv('CLUSTER_FILE_PATH', '/tmp/does-not-exist-nsm-cluster.json');
        const { loadClusterFile, config } = await import('@/config');
        const cf = loadClusterFile();
        expect(cf.nodes).toHaveLength(1);
        expect(cf.nodes[0].nodeId).toBe(config.nodeId);
    });

    it('saveClusterFile then loadClusterFile round-trips', async () => {
        const os = await import('os');
        const path = await import('path');
        const fs = await import('fs');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nsm-cf-')), 'cluster.json');
        vi.stubEnv('CLUSTER_FILE_PATH', file);
        const { saveClusterFile, loadClusterFile } = await import('@/config');
        const cf = { clusterId: 'c', nodes: [{ nodeId: 'n1', address: '1.2.3.4', raftPort: 1, apiPort: 2 }], vip: '9.9.9.9', vrrpRouterId: 7 };
        saveClusterFile(cf);
        expect(loadClusterFile()).toEqual(cf);
    });
});
