import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';

// getVisibleProjects isn't exercised here (annotateQueueEtas is tested directly), but statusController
// imports it transitively; keep the module graph light.
vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true), status: vi.fn() } }));

import { annotateQueueEtas } from '@/controllers/statusController';
import { INTER_DEPLOY_DELAY_MS } from '@/controllers/deployQueue';
import { createProjectInstanceModel, getRecentDeployDurationsModel } from '@/persistence/projectInstancePersistence';
import { DeployQueueState, DeploymentState } from '@mosaiq/nsm-common/types';

// Seed a finished deploy instance for a project with a known duration.
const seedDeploy = async (projectId: string, deployStartedAt: number, deployDurationMs: number, state = DeploymentState.DEPLOYED) => {
    await createProjectInstanceModel({
        id: `${projectId}-${deployStartedAt}`,
        projectId,
        workerNodeId: 'n1',
        state,
        created: deployStartedAt,
        lastUpdated: deployStartedAt + deployDurationMs,
        active: false,
        directories: {},
        deployStartedAt,
        deployDurationMs,
    });
};

beforeEach(async () => {
    await resetDb();
});

describe('getRecentDeployDurationsModel', () => {
    it('returns only successful deploys with a duration, newest first, capped at the limit', async () => {
        await seedDeploy('a', 1000, 100);
        await seedDeploy('a', 3000, 300);
        await seedDeploy('a', 2000, 200);
        // A failed deploy and a durationless one are ignored.
        await seedDeploy('a', 5000, 999, DeploymentState.FAILED);
        await createProjectInstanceModel({ id: 'a-nodur', projectId: 'a', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: 4000, lastUpdated: 4000, active: false, directories: {} });

        const durations = await getRecentDeployDurationsModel('a', 2);
        // Newest two by deployStartedAt: 3000 (300) then 2000 (200).
        expect(durations).toEqual([300, 200]);
    });

    it('returns an empty array for a project with no successful deploys', async () => {
        expect(await getRecentDeployDurationsModel('ghost', 10)).toEqual([]);
    });
});

describe('annotateQueueEtas', () => {
    it('estimates deploy time and cumulative wait across the serial queue', async () => {
        // Project a averages 150s, project b averages 60s.
        await seedDeploy('a', 1000, 100_000);
        await seedDeploy('a', 2000, 200_000);
        await seedDeploy('b', 1000, 60_000);

        const now = Date.now();
        const queue: DeployQueueState = {
            active: null,
            deploying: [{ projectId: 'a', instanceId: 'ia', enqueuedAt: now, startedAt: now }],
            queued: [
                { projectId: 'b', instanceId: 'ib', enqueuedAt: now },
                { projectId: 'a', instanceId: 'ia2', enqueuedAt: now },
            ],
        };

        await annotateQueueEtas(queue);

        const near = (actual: number | undefined, expected: number) => {
            expect(actual).toBeDefined();
            expect(Math.abs((actual as number) - expected)).toBeLessThan(3_000);
        };

        // In-flight 'a': no wait, own deploy ~150s from 2 samples.
        expect(queue.deploying[0].estimatedWaitMs).toBe(0);
        near(queue.deploying[0].estimatedDeployMs, 150_000);
        expect(queue.deploying[0].avgSampleCount).toBe(2);

        // Queued 'b': waits for 'a' to finish (~150s) + one buffer.
        near(queue.queued[0].estimatedWaitMs, 150_000 + INTER_DEPLOY_DELAY_MS);
        near(queue.queued[0].estimatedDeployMs, 60_000);
        expect(queue.queued[0].avgSampleCount).toBe(1);

        // Queued 'a' (2nd): after 'b' (~150s + buffer) then b's deploy (~60s) + another buffer.
        near(queue.queued[1].estimatedWaitMs, 150_000 + INTER_DEPLOY_DELAY_MS + 60_000 + INTER_DEPLOY_DELAY_MS);
        near(queue.queued[1].estimatedDeployMs, 150_000);
    });

    it('falls back to the average of the other queued projects for one with no history', async () => {
        await seedDeploy('a', 1000, 100_000);
        await seedDeploy('b', 1000, 200_000);

        const now = Date.now();
        const queue: DeployQueueState = {
            active: null,
            deploying: [],
            queued: [
                { projectId: 'a', instanceId: 'ia', enqueuedAt: now },
                { projectId: 'b', instanceId: 'ib', enqueuedAt: now },
                { projectId: 'c', instanceId: 'ic', enqueuedAt: now },
            ],
        };

        await annotateQueueEtas(queue);

        // 'c' has no history -> fallback is the mean of the known per-project averages present in the
        // queue (100s and 200s -> 150s), and its sample count is 0 to signal a fallback.
        expect(queue.queued[2].estimatedDeployMs).toBe(150_000);
        expect(queue.queued[2].avgSampleCount).toBe(0);
    });

    it('leaves estimates undefined when no project has any history', async () => {
        const now = Date.now();
        const queue: DeployQueueState = {
            active: null,
            deploying: [],
            queued: [{ projectId: 'x', instanceId: 'ix', enqueuedAt: now }],
        };

        await annotateQueueEtas(queue);

        expect(queue.queued[0].estimatedDeployMs).toBeUndefined();
        expect(queue.queued[0].avgSampleCount).toBe(0);
        expect(queue.queued[0].estimatedWaitMs).toBe(0);
    });
});
