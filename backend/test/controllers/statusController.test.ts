import { describe, it, expect, vi, Mock } from 'vitest';
import { DeploymentState, User } from '@mosaiq/nsm-common/types';

const status = { leaderId: 'a', nodes: [], health: [], desiredNsmVersion: null };
vi.mock('@/cluster/node', () => ({ cluster: { status: vi.fn(async () => status) } }));
vi.mock('@/controllers/deployQueue', () => ({ getDeployQueueState: vi.fn(() => ({ active: null, queued: [], deploying: [] })) }));
vi.mock('@/persistence/projectInstancePersistence', () => ({ getAllActiveProjectInstancesModel: vi.fn(async () => []) }));
vi.mock('@/controllers/teamController', () => ({ getVisibleProjects: vi.fn(async () => []) }));

import { getControlPlaneStatus } from '@/controllers/statusController';
import { getAllActiveProjectInstancesModel } from '@/persistence/projectInstancePersistence';
import { getVisibleProjects } from '@/controllers/teamController';

const mockInstances = getAllActiveProjectInstancesModel as unknown as Mock;
const mockVisible = getVisibleProjects as unknown as Mock;
const user = { name: 'u', githubId: '1', avatarUrl: '', authToken: 't', created: 0, signedIn: true } as User;

describe('getControlPlaneStatus', () => {
    it('delegates to cluster.status() and attaches the deploy queue', async () => {
        mockInstances.mockResolvedValueOnce([]);
        expect(await getControlPlaneStatus(null)).toEqual({ ...status, deployQueue: { active: null, queued: [], deploying: [] } });
    });

    it('derives the deploying list from DEPLOYING ProjectInstances', async () => {
        mockInstances.mockResolvedValueOnce([
            { id: 'iDep', projectId: 'p1', state: DeploymentState.DEPLOYING, created: 100 },
            { id: 'iDone', projectId: 'p2', state: DeploymentState.DEPLOYED, created: 200 },
        ]);
        mockVisible.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);
        const result = await getControlPlaneStatus(user);
        expect(result.deployQueue?.deploying).toEqual([{ projectId: 'p1', instanceId: 'iDep', enqueuedAt: 100, startedAt: 100 }]);
    });

    it('redacts queue entries for projects the user cannot see', async () => {
        mockInstances.mockResolvedValueOnce([
            { id: 'iVis', projectId: 'p1', state: DeploymentState.DEPLOYING, created: 100 },
            { id: 'iHid', projectId: 'secret', state: DeploymentState.DEPLOYING, created: 200 },
        ]);
        mockVisible.mockResolvedValueOnce([{ id: 'p1' }]);
        const result = await getControlPlaneStatus(user);
        expect(result.deployQueue?.deploying).toEqual([
            { projectId: 'p1', instanceId: 'iVis', enqueuedAt: 100, startedAt: 100 },
            { projectId: '', instanceId: '', enqueuedAt: 0, startedAt: 0, hidden: true },
        ]);
    });
});
