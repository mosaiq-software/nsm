import { describe, it, expect, vi } from 'vitest';

const status = { leaderId: 'a', term: 3, nodes: [], health: [], desiredNsmVersion: null, vip: null };
vi.mock('@/cluster/node', () => ({ cluster: { status: vi.fn(async () => status) } }));

import { getControlPlaneStatus } from '@/controllers/statusController';

describe('getControlPlaneStatus', () => {
    it('delegates to cluster.status()', async () => {
        expect(await getControlPlaneStatus()).toEqual(status);
    });
});
