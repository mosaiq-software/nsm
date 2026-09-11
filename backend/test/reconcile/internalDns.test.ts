import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })) }));
vi.mock('@/persistence/nodePersistence', () => ({ getAllNodesModel: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { buildManagedBlock, refreshInternalHosts } from '@/reconcile/internalDns';

const mNodes = getAllNodesModel as unknown as Mock;
const mExec = execSafe as unknown as Mock;

describe('buildManagedBlock', () => {
    it('maps <nodeId>.<domain> -> current IP inside NSM markers', () => {
        const block = buildManagedBlock(
            [
                { nodeId: 'a', address: '10.0.0.1' },
                { nodeId: 'b', address: '10.0.0.2' },
            ],
            'nsm.internal'
        );
        expect(block).toContain('# BEGIN NSM-managed');
        expect(block).toContain('10.0.0.1 a.nsm.internal');
        expect(block).toContain('10.0.0.2 b.nsm.internal');
        expect(block).toContain('# END NSM-managed');
    });
});

describe('refreshInternalHosts', () => {
    let tmpHosts: string;
    beforeEach(async () => {
        config.production = true;
        mNodes.mockReset();
        mExec.mockClear();
        tmpHosts = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'nsm-hosts-')), 'hosts');
        process.env.NSM_HOSTS_PATH = tmpHosts;
    });
    afterEach(() => {
        config.production = false;
        delete process.env.NSM_HOSTS_PATH;
    });

    it('is a no-op outside production', async () => {
        config.production = false;
        mNodes.mockResolvedValue([{ nodeId: 'a', address: '10.0.0.1' }]);
        expect(await refreshInternalHosts()).toBe(false);
        expect(mExec).not.toHaveBeenCalled();
    });

    it('writes the managed block, preserves other entries, reloads nginx, and is idempotent', async () => {
        await fsp.writeFile(tmpHosts, '127.0.0.1 localhost\n');
        mNodes.mockResolvedValue([{ nodeId: 'a', address: '10.0.0.1', apiPort: 1, lastSeen: 0, isLeader: true }]);

        const changed1 = await refreshInternalHosts();
        expect(changed1).toBe(true);
        const written = await fsp.readFile(tmpHosts, 'utf-8');
        expect(written).toContain('127.0.0.1 localhost'); // preserved
        expect(written).toContain('10.0.0.1 a.nsm.internal');
        expect(mExec).toHaveBeenCalledWith('sudo -n nginx -s reload', expect.any(Number));

        // Second run with identical registry must not rewrite or reload.
        mExec.mockClear();
        const changed2 = await refreshInternalHosts();
        expect(changed2).toBe(false);
        expect(mExec).not.toHaveBeenCalled();
    });

    it('rewrites the block (single managed section) when an IP changes', async () => {
        mNodes.mockResolvedValue([{ nodeId: 'a', address: '10.0.0.1', apiPort: 1, lastSeen: 0, isLeader: true }]);
        await refreshInternalHosts();
        mNodes.mockResolvedValue([{ nodeId: 'a', address: '10.0.0.9', apiPort: 1, lastSeen: 0, isLeader: true }]);
        const changed = await refreshInternalHosts();
        expect(changed).toBe(true);
        const written = await fsp.readFile(tmpHosts, 'utf-8');
        expect(written).toContain('10.0.0.9 a.nsm.internal');
        expect(written).not.toContain('10.0.0.1 a.nsm.internal');
        // Exactly one managed block.
        expect(written.match(/# BEGIN NSM-managed/g)).toHaveLength(1);
    });
});
