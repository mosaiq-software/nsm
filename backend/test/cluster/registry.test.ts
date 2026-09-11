import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/host/exec', () => ({ getPrimaryIp: vi.fn(async () => '10.0.0.42') }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn(async () => ({ nodes: [] })) }));

import { config } from '@/config';
import { getPrimaryIp } from '@/host/exec';
import { postToLeader } from '@/cluster/leaderClient';
import { registerNode, deregisterNode, getRegistry, ensureSelfRegistered } from '@/cluster/registry';
import { getNodeByIdModel } from '@/persistence/nodePersistence';

const mPrimaryIp = getPrimaryIp as unknown as Mock;
const mPost = postToLeader as unknown as Mock;

beforeEach(async () => {
    await resetDb();
    mPrimaryIp.mockClear();
    mPost.mockClear();
    config.role = 'leader';
});

describe('registerNode / getRegistry', () => {
    it('rejects an invalid registration', async () => {
        await expect(registerNode({ nodeId: '', address: '', apiPort: 1 })).rejects.toThrow(/invalid/);
    });

    it('upserts a node and reflects an IP change (same nodeId, new address)', async () => {
        await registerNode({ nodeId: 'n1', address: '1.1.1.1', apiPort: 1025 });
        expect((await getRegistry()).nodes).toContainEqual(expect.objectContaining({ nodeId: 'n1', address: '1.1.1.1' }));
        await registerNode({ nodeId: 'n1', address: '2.2.2.2', apiPort: 1025 });
        const snap = await getRegistry();
        expect(snap.nodes).toHaveLength(1);
        expect(snap.nodes[0].address).toBe('2.2.2.2');
    });

    it('marks the leader row isLeader when it registers itself', async () => {
        await registerNode({ nodeId: config.nodeId, address: '9.9.9.9', apiPort: config.apiPort });
        expect((await getNodeByIdModel(config.nodeId))?.isLeader).toBe(true);
    });

    it('deregisterNode removes the row', async () => {
        await registerNode({ nodeId: 'n1', address: '1.1.1.1', apiPort: 1025 });
        await deregisterNode('n1');
        expect(await getNodeByIdModel('n1')).toBeFalsy();
    });
});

describe('ensureSelfRegistered', () => {
    it('as leader writes its own row locally (no HTTP)', async () => {
        config.role = 'leader';
        await ensureSelfRegistered();
        expect(mPost).not.toHaveBeenCalled();
        expect((await getNodeByIdModel(config.nodeId))?.address).toBe('10.0.0.42');
    });

    it('as follower announces itself to the leader over HTTP', async () => {
        config.role = 'follower';
        await ensureSelfRegistered();
        expect(mPost).toHaveBeenCalledWith('/cluster/register', { nodeId: config.nodeId, address: '10.0.0.42', apiPort: config.apiPort });
    });
});
