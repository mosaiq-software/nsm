import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true) } }));
vi.mock('@/controllers/projectController', () => ({ getProject: vi.fn() }));
vi.mock('@/controllers/deployController', () => ({ deployProject: vi.fn(), updateDeploymentLog: vi.fn(async () => {}) }));

import { getProject } from '@/controllers/projectController';
import { deployProject } from '@/controllers/deployController';
import { cancelQueuedDeploy, enqueueDeploy, getDeployQueueState, recoverDeployQueue } from '@/controllers/deployQueue';
import { updateDeploymentLog } from '@/controllers/deployController';
import { createProjectInstanceModel, getProjectInstanceByIdModel } from '@/persistence/projectInstancePersistence';
import { DeploymentState } from '@mosaiq/nsm-common/types';

const mockGetProject = getProject as unknown as Mock;
const mockDeploy = deployProject as unknown as Mock;
const mockUpdateLog = updateDeploymentLog as unknown as Mock;

// Delay the queue inserts between consecutive deploys; tests advance past it with fake timers.
const INTER_DEPLOY_DELAY_MS = 30_000;

const flush = () => vi.advanceTimersByTimeAsync(0);

// Controllable deploys: each call parks until we resolve it, so we can observe queue state while a
// deploy is "in flight" and assert that only one runs at a time.
let started: string[] = [];
let resolvers: Array<() => void> = [];
let activeCount = 0;
let maxConcurrent = 0;

beforeEach(async () => {
    vi.useFakeTimers();
    await resetDb();
    started = [];
    resolvers = [];
    activeCount = 0;
    maxConcurrent = 0;
    mockGetProject.mockReset().mockResolvedValue({ id: 'x', workerNodeId: 'n1' });
    mockDeploy.mockReset().mockImplementation((projectId: string) => {
        started.push(projectId);
        activeCount++;
        maxConcurrent = Math.max(maxConcurrent, activeCount);
        return new Promise<void>((resolve) => {
            resolvers.push(() => {
                activeCount--;
                resolve();
            });
        });
    });
});

// Drain anything still parked so the module-level singleton is idle for the next test. Resolving a
// deploy can start the next one (which parks again), so loop until the queue is fully idle.
afterEach(async () => {
    for (let i = 0; i < 100; i++) {
        while (resolvers.length) resolvers.shift()!();
        await vi.advanceTimersByTimeAsync(INTER_DEPLOY_DELAY_MS);
        const state = getDeployQueueState();
        if (!state.active && state.queued.length === 0 && resolvers.length === 0) break;
    }
    vi.useRealTimers();
});

// Finish the active deploy and let the queue advance past the inter-deploy delay so the next
// deploy (if any) starts.
const resolveNext = async () => {
    resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(INTER_DEPLOY_DELAY_MS);
};

describe('deploy queue serialization', () => {
    it('runs one deploy at a time in FIFO order', async () => {
        await enqueueDeploy('p1');
        await enqueueDeploy('p2');
        await enqueueDeploy('p3');

        // Only p1 is running; p2/p3 wait in order.
        expect(maxConcurrent).toBe(1);
        expect(started).toEqual(['p1']);
        let state = getDeployQueueState();
        expect(state.active?.projectId).toBe('p1');
        expect(state.queued.map((e) => e.projectId)).toEqual(['p2', 'p3']);

        await resolveNext(); // finish p1 -> p2 starts
        expect(started).toEqual(['p1', 'p2']);
        state = getDeployQueueState();
        expect(state.active?.projectId).toBe('p2');
        expect(state.queued.map((e) => e.projectId)).toEqual(['p3']);

        await resolveNext(); // finish p2 -> p3 starts
        await resolveNext(); // finish p3 -> idle
        expect(maxConcurrent).toBe(1);
        state = getDeployQueueState();
        expect(state.active).toBeNull();
        expect(state.queued).toEqual([]);
    });

    it('creates a QUEUED instance immediately and returns its id', async () => {
        // Park p0 so p1 stays queued (not yet active) while we inspect it.
        await enqueueDeploy('p0');
        const instanceId = await enqueueDeploy('p1');
        expect(instanceId).toBeTruthy();
        const inst = await getProjectInstanceByIdModel(instanceId!);
        expect(inst?.state).toBe(DeploymentState.QUEUED);
    });

    it('deduplicates a project already active or queued', async () => {
        const first = await enqueueDeploy('p1'); // becomes active
        const again = await enqueueDeploy('p1'); // active dup -> same id, no new run
        expect(again).toBe(first);

        await enqueueDeploy('p2'); // queued behind active p1
        const p2dup = await enqueueDeploy('p2'); // queued dup -> same id
        expect(getDeployQueueState().queued.map((e) => e.projectId)).toEqual(['p2']);
        expect(p2dup).toBe(getDeployQueueState().queued[0].instanceId);

        // Only p1 ever started despite the duplicate enqueues.
        expect(started).toEqual(['p1']);
    });

    it('recovers QUEUED instances left in the DB after a restart', async () => {
        await createProjectInstanceModel({ id: 'recovered', projectId: 'pr', workerNodeId: 'n1', state: DeploymentState.QUEUED, created: 1000, lastUpdated: 1000, active: true, directories: {} });
        await recoverDeployQueue();
        await flush();
        expect(started).toContain('pr');
    });
});

describe('deploy queue cancellation', () => {
    it('cancels a queued project: removes it and marks it CANCELLED', async () => {
        await enqueueDeploy('p1'); // becomes active (parked)
        const p2id = await enqueueDeploy('p2'); // queued behind p1
        expect(getDeployQueueState().queued.map((e) => e.projectId)).toEqual(['p2']);

        const phase = await cancelQueuedDeploy('p2');
        expect(phase).toBe('queued');
        expect(getDeployQueueState().queued).toEqual([]);
        expect(mockUpdateLog).toHaveBeenCalledWith(p2id, DeploymentState.CANCELLED, expect.stringContaining('cancelled'));
    });

    it('flags the actively-planning project as planning without touching the queue', async () => {
        await enqueueDeploy('p1'); // active/planning
        const phase = await cancelQueuedDeploy('p1');
        expect(phase).toBe('planning');
        expect(getDeployQueueState().active?.projectId).toBe('p1');
    });

    it('returns none for a project that is neither queued nor planning', async () => {
        expect(await cancelQueuedDeploy('ghost')).toBe('none');
    });
});
