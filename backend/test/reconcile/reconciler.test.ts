import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true) } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({
    getDesiredDeploymentsAssignedToModel: vi.fn(),
    upsertDesiredDeploymentModel: vi.fn(),
    deleteDesiredDeploymentModel: vi.fn(),
}));
vi.mock('@/reconcile/deploy', () => ({ applyDeployment: vi.fn() }));
vi.mock('@/reconcile/teardown', () => ({ teardownProjectLocal: vi.fn() }));
vi.mock('@/reconcile/nginxRender', () => ({ renderAllNginx: vi.fn(async () => ({ changed: false })) }));
vi.mock('@/reconcile/certs', () => ({ leaderEnsureCerts: vi.fn() }));
vi.mock('@/reconcile/internalDns', () => ({ refreshInternalHosts: vi.fn() }));
vi.mock('@/reconcile/promTargets', () => ({ regeneratePromTargets: vi.fn() }));
vi.mock('@/reconcile/state', () => ({ getLocalGeneration: vi.fn(), listLocalProjects: vi.fn(), clearLocalGeneration: vi.fn(), setLocalGeneration: vi.fn() }));

import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { getDesiredDeploymentsAssignedToModel, upsertDesiredDeploymentModel, deleteDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { applyDeployment } from '@/reconcile/deploy';
import { teardownProjectLocal } from '@/reconcile/teardown';
import { renderAllNginx } from '@/reconcile/nginxRender';
import { leaderEnsureCerts } from '@/reconcile/certs';
import { refreshInternalHosts } from '@/reconcile/internalDns';
import { regeneratePromTargets } from '@/reconcile/promTargets';
import { getLocalGeneration, listLocalProjects, clearLocalGeneration } from '@/reconcile/state';
import { reconcileTick } from '@/reconcile/reconciler';

const mIsLeader = cluster.isLeader as unknown as Mock;
const mPull = postToLeader as unknown as Mock;
const mAssigned = getDesiredDeploymentsAssignedToModel as unknown as Mock;
const mUpsert = upsertDesiredDeploymentModel as unknown as Mock;
const mDelete = deleteDesiredDeploymentModel as unknown as Mock;
const mApply = applyDeployment as unknown as Mock;
const mTeardown = teardownProjectLocal as unknown as Mock;
const mNginx = renderAllNginx as unknown as Mock;
const mCerts = leaderEnsureCerts as unknown as Mock;
const mHosts = refreshInternalHosts as unknown as Mock;
const mProm = regeneratePromTargets as unknown as Mock;
const mGetGen = getLocalGeneration as unknown as Mock;
const mList = listLocalProjects as unknown as Mock;
const mClear = clearLocalGeneration as unknown as Mock;

const dep = (projectId: string, generation: number) => ({ projectId, generation, assignedNodeId: 'test-node', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', domains: [], services: [] });

beforeEach(() => {
    vi.clearAllMocks();
    mIsLeader.mockReturnValue(true);
});

describe('reconcileTick (leader)', () => {
    it('deploys on generation drift, tears down de-assigned projects, and wires leader-only ingress', async () => {
        mAssigned.mockResolvedValue([dep('p1', 2), dep('p2', 1)]);
        mGetGen.mockImplementation(async (id: string) => (id === 'p1' ? 1 : 1)); // p1 drifts, p2 matches
        mList.mockResolvedValue(['p1', 'p3']); // p3 no longer assigned

        await reconcileTick();

        expect(mApply).toHaveBeenCalledTimes(1);
        expect(mApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', generation: 2 }));
        expect(mTeardown).toHaveBeenCalledWith('p3');
        expect(mClear).toHaveBeenCalledWith('p3');
        // Leader-only ingress + observability wiring runs.
        expect(mCerts).toHaveBeenCalledTimes(1);
        expect(mNginx).toHaveBeenCalledTimes(1);
        expect(mHosts).toHaveBeenCalledTimes(1);
        expect(mProm).toHaveBeenCalledTimes(1);
        // Leader never pulls.
        expect(mPull).not.toHaveBeenCalled();
    });
});

describe('reconcileTick (follower)', () => {
    beforeEach(() => mIsLeader.mockReturnValue(false));

    it('pulls desired state from the leader, upserts present + deletes removed, and skips ingress', async () => {
        mPull.mockResolvedValue({ deployments: [dep('p1', 1)], registry: [] });
        // Before pull, the follower still has p1 (want) and pOld (removed) assigned locally.
        mAssigned.mockResolvedValueOnce([dep('p1', 1), dep('pOld', 1)]) // during reconcile of removed set
            .mockResolvedValue([dep('p1', 1)]); // the assigned set the reconciler iterates
        mGetGen.mockResolvedValue(1);
        mList.mockResolvedValue([]);

        await reconcileTick();

        expect(mUpsert).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
        expect(mDelete).toHaveBeenCalledWith('pOld'); // teardown propagates
        // Followers never render ingress / certs / hosts / prom targets.
        expect(mCerts).not.toHaveBeenCalled();
        expect(mNginx).not.toHaveBeenCalled();
        expect(mHosts).not.toHaveBeenCalled();
        expect(mProm).not.toHaveBeenCalled();
    });

    it('bails out without tearing anything down when the leader is unreachable', async () => {
        mPull.mockResolvedValue(null);
        await reconcileTick();
        expect(mApply).not.toHaveBeenCalled();
        expect(mTeardown).not.toHaveBeenCalled();
    });
});
