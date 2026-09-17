import { describe, it, expect, vi, Mock } from 'vitest';
import { DeploymentState } from '@mosaiq/nsm-common/types';

const status = { leaderId: 'a', nodes: [], health: [], desiredNsmVersion: null };
vi.mock('@/cluster/node', () => ({ cluster: { status: vi.fn(async () => status) } }));
vi.mock('@/controllers/deployQueue', () => ({ getDeployQueueState: vi.fn(() => ({ active: null, queued: [], deploying: [] })) }));
vi.mock('@/persistence/projectInstancePersistence', () => ({ getAllActiveProjectInstancesModel: vi.fn(async () => []) }));

import { getControlPlaneStatus } from '@/controllers/statusController';
import { getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';

const mockInstances = getAllActiveProjectInstancesModel as unknown as Mock;

describe('getControlPlaneStatus', () => {
    it('delegates to cluster.status() and attaches the deploy queue', async () => {
        mockInstances.mockResolvedValueOnce([]);
        expect(await getControlPlaneStatus()).toEqual({ ...status, deployQueue: { active: null, queued: [], deploying: [] } });
    });

    it('derives the deploying list from DEPLOYING ProjectInstances', async () => {
        mockInstances.mockResolvedValueOnce([
            { id: 'iDep', projectId: 'p1', state: DeploymentState.DEPLOYING, created: 100 },
            { id: 'iDone', projectId: 'p2', state: DeploymentState.DEPLOYED, created: 200 },
        ]);
        const result = await getControlPlaneStatus();
        expect(result.deployQueue?.deploying).toEqual([{ projectId: 'p1', instanceId: 'iDep', enqueuedAt: 100, startedAt: 100 }]);
    });
});
