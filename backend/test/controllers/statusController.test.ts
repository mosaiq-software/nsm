import { describe, it, expect, vi } from 'vitest';

const status = { leaderId: 'a', nodes: [], health: [], desiredNsmVersion: null };
vi.mock('@/cluster/node', () => ({ cluster: { status: vi.fn(async () => status) } }));
vi.mock('@/controllers/deployQueue', () => ({ getDeployQueueState: vi.fn(() => ({ active: null, queued: [] })) }));

import { getControlPlaneStatus } from '@/controllers/statusController';

describe('getControlPlaneStatus', () => {
    it('delegates to cluster.status() and attaches the deploy queue', async () => {
        expect(await getControlPlaneStatus()).toEqual({ ...status, deployQueue: { active: null, queued: [] } });
    });
});
