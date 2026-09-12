import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true) } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({
    getDesiredDeploymentsAssignedToModel: vi.fn(),
    upsertDesiredDeploymentModel: vi.fn(),
    deleteDesiredDeploymentModel: vi.fn(),
}));
vi.mock('@/reconcile/deploy', () => ({ applyDeployment: vi.fn() }));
vi.mock('@/reconcile/teardown', () => ({ teardownProjectLocal: vi.fn(), teardownGenerationLocal: vi.fn() }));
vi.mock('@/reconcile/nginxRender', () => ({ renderAllNginx: vi.fn(async () => ({ changed: false })) }));
vi.mock('@/reconcile/certs', () => ({ leaderEnsureCerts: vi.fn() }));
vi.mock('@/reconcile/internalDns', () => ({ refreshInternalHosts: vi.fn() }));
vi.mock('@/reconcile/promTargets', () => ({ regeneratePromTargets: vi.fn() }));
vi.mock('@/reconcile/state', () => ({
    getLocalGeneration: vi.fn(),
    getReadyGeneration: vi.fn(),
    getLiveGenerations: vi.fn(async () => []),
    removeLiveGeneration: vi.fn(),
    listLocalProjects: vi.fn(),
    clearLocalGeneration: vi.fn(),
    setLocalGeneration: vi.fn(),
}));

import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { getDesiredDeploymentsAssignedToModel, upsertDesiredDeploymentModel, deleteDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { applyDeployment } from '@/reconcile/deploy';
import { teardownProjectLocal, teardownGenerationLocal } from '@/reconcile/teardown';
import { renderAllNginx } from '@/reconcile/nginxRender';
import { leaderEnsureCerts } from '@/reconcile/certs';
import { refreshInternalHosts } from '@/reconcile/internalDns';
import { regeneratePromTargets } from '@/reconcile/promTargets';
import { getLocalGeneration, getReadyGeneration, getLiveGenerations, removeLiveGeneration, listLocalProjects, clearLocalGeneration } from '@/reconcile/state';
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
const mGetReady = getReadyGeneration as unknown as Mock;
const mGetLive = getLiveGenerations as unknown as Mock;
const mRemoveLive = removeLiveGeneration as unknown as Mock;
const mList = listLocalProjects as unknown as Mock;
const mClear = clearLocalGeneration as unknown as Mock;
const mGenTeardown = teardownGenerationLocal as unknown as Mock;

const dep = (projectId: string, generation: number, over: Record<string, unknown> = {}) => ({ projectId, generation, assignedNodeId: 'test-node', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', domains: [], services: [], zeroDowntime: false, ports: [], ...over });

beforeEach(() => {
    vi.clearAllMocks();
    mIsLeader.mockReturnValue(true);
    mGetLive.mockResolvedValue([]);
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

describe('reconcileTick (zero-downtime / blue-green)', () => {
    it('deploys when the READY generation has not caught up to the desired generation', async () => {
        mAssigned.mockResolvedValue([dep('zd1', 3, { zeroDowntime: true, activeGeneration: 2 })]);
        mGetReady.mockResolvedValue(2); // ready trails desired -> redeploy the new (blue) generation
        mList.mockResolvedValue([]);

        await reconcileTick();

        expect(mApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'zd1', generation: 3 }));
        // Legacy single-generation drift check is not used on the blue-green path.
        expect(mGetGen).not.toHaveBeenCalled();
    });

    it('does not redeploy once the READY generation equals the desired generation', async () => {
        mAssigned.mockResolvedValue([dep('zd2', 3, { zeroDowntime: true, activeGeneration: 3 })]);
        mGetReady.mockResolvedValue(3);
        mList.mockResolvedValue([]);

        await reconcileTick();

        expect(mApply).not.toHaveBeenCalled();
    });

    it('drains generations older than the promoted active generation after the grace period', async () => {
        const originalDrain = config.deployDrainMs;
        config.deployDrainMs = 0;
        try {
            mAssigned.mockResolvedValue([dep('zd3', 3, { zeroDowntime: true, activeGeneration: 3 })]);
            mGetReady.mockResolvedValue(3);
            mGetLive.mockResolvedValue([2, 3]); // gen 2 is stale now that 3 is active
            mList.mockResolvedValue([]);

            await reconcileTick();
            await new Promise((r) => setTimeout(r, 10)); // let the scheduled drain fire

            expect(mGenTeardown).toHaveBeenCalledWith('zd3', 2);
            expect(mRemoveLive).toHaveBeenCalledWith('zd3', 2);
            expect(mGenTeardown).not.toHaveBeenCalledWith('zd3', 3); // never tears down the active gen
        } finally {
            config.deployDrainMs = originalDrain;
        }
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
