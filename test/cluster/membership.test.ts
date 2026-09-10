import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(), addNode: vi.fn(), removeNode: vi.fn() } }));

import { cluster } from '@/cluster/node';
import { config } from '@/config';
import { handleJoin, handleRemove } from '@/cluster/membership';

const isLeader = cluster.isLeader as unknown as Mock;
const addNode = cluster.addNode as unknown as Mock;
const removeNode = cluster.removeNode as unknown as Mock;

const node = { nodeId: 'n2', address: '10.0.0.2', raftPort: 1, apiPort: 2 };

beforeEach(() => {
    isLeader.mockReset();
    addNode.mockReset();
    removeNode.mockReset();
});

describe('handleJoin', () => {
    it('rejects when not the leader', async () => {
        isLeader.mockReturnValue(false);
        expect(await handleJoin({ node, token: config.clusterSecret })).toEqual({ ok: false, error: 'not-leader' });
    });

    it('rejects an invalid token', async () => {
        isLeader.mockReturnValue(true);
        expect(await handleJoin({ node, token: 'wrong' })).toEqual({ ok: false, error: 'invalid-token' });
    });

    it('rejects a malformed node', async () => {
        isLeader.mockReturnValue(true);
        const res = await handleJoin({ node: { nodeId: '', address: '' } as any, token: config.clusterSecret });
        expect(res.ok).toBe(false);
        expect(res.error).toBe('invalid-node');
    });

    it('adds the node and returns the cluster file on success', async () => {
        isLeader.mockReturnValue(true);
        const res = await handleJoin({ node, token: config.clusterSecret });
        expect(addNode).toHaveBeenCalledWith(node);
        expect(res.ok).toBe(true);
        expect(res.cluster).toBeTruthy();
    });
});

describe('handleRemove', () => {
    it('rejects when not the leader, removes otherwise', async () => {
        isLeader.mockReturnValue(false);
        expect((await handleRemove('n2')).ok).toBe(false);
        isLeader.mockReturnValue(true);
        expect((await handleRemove('n2')).ok).toBe(true);
        expect(removeNode).toHaveBeenCalledWith('n2');
    });
});
