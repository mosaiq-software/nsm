import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getDesiredDeploymentsAssignedToModel: vi.fn() }));
vi.mock('@/reconcile/deploy', () => ({ applyDeployment: vi.fn() }));
vi.mock('@/reconcile/teardown', () => ({ teardownProjectLocal: vi.fn() }));
vi.mock('@/reconcile/nginxRender', () => ({ renderAllNginx: vi.fn(async () => ({ changed: false })) }));
vi.mock('@/reconcile/certs', () => ({ syncCertsToDisk: vi.fn() }));
vi.mock('@/reconcile/state', () => ({ getLocalGeneration: vi.fn(), listLocalProjects: vi.fn(), clearLocalGeneration: vi.fn(), setLocalGeneration: vi.fn() }));

import { getDesiredDeploymentsAssignedToModel } from '@/persistence/desiredDeploymentPersistence';
import { applyDeployment } from '@/reconcile/deploy';
import { teardownProjectLocal } from '@/reconcile/teardown';
import { renderAllNginx } from '@/reconcile/nginxRender';
import { syncCertsToDisk } from '@/reconcile/certs';
import { getLocalGeneration, listLocalProjects, clearLocalGeneration } from '@/reconcile/state';
import { reconcileTick } from '@/reconcile/reconciler';

const mAssigned = getDesiredDeploymentsAssignedToModel as unknown as Mock;
const mApply = applyDeployment as unknown as Mock;
const mTeardown = teardownProjectLocal as unknown as Mock;
const mNginx = renderAllNginx as unknown as Mock;
const mCerts = syncCertsToDisk as unknown as Mock;
const mGetGen = getLocalGeneration as unknown as Mock;
const mList = listLocalProjects as unknown as Mock;
const mClear = clearLocalGeneration as unknown as Mock;

const dep = (projectId: string, generation: number) => ({ projectId, generation, assignedNodeId: 'test-node', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', domains: [], services: [] });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('reconcileTick', () => {
    it('deploys on generation drift, tears down de-assigned projects, and always syncs ingress', async () => {
        mAssigned.mockResolvedValue([dep('p1', 2), dep('p2', 1)]);
        mGetGen.mockImplementation(async (id: string) => (id === 'p1' ? 1 : 1)); // p1 drifts (want 2), p2 matches
        mList.mockResolvedValue(['p1', 'p3']); // p3 no longer assigned

        await reconcileTick();

        expect(mApply).toHaveBeenCalledTimes(1);
        expect(mApply).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', generation: 2 }));
        expect(mTeardown).toHaveBeenCalledWith('p3');
        expect(mClear).toHaveBeenCalledWith('p3');
        expect(mCerts).toHaveBeenCalledTimes(1);
        expect(mNginx).toHaveBeenCalledTimes(1);
    });
});
