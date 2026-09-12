import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import { config } from '@/config';
import {
    getLocalGeneration,
    setLocalGeneration,
    clearLocalGeneration,
    listLocalProjects,
    getReadyGeneration,
    getLiveGenerations,
    markGenerationLive,
    markGenerationReady,
    removeLiveGeneration,
    readMarker,
} from '@/reconcile/state';

describe('local generation state', () => {
    it('returns null for an unknown project', async () => {
        expect(await getLocalGeneration('unknown')).toBeNull();
    });

    it('sets, reads, lists and clears generation markers', async () => {
        await setLocalGeneration('p1', 4);
        await setLocalGeneration('p2', 9);
        expect(await getLocalGeneration('p1')).toBe(4);
        expect((await listLocalProjects()).sort()).toContain('p1');
        await clearLocalGeneration('p1');
        expect(await getLocalGeneration('p1')).toBeNull();
    });

    it('reads a legacy bare-integer marker as a single fully-deployed, ready generation', async () => {
        const dir = `${config.databaseDir}/generations`;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/legacy`, '7');
        const m = await readMarker('legacy');
        expect(m).toEqual({ deployedGeneration: 7, readyGeneration: 7, liveGenerations: [7] });
        expect(await getLocalGeneration('legacy')).toBe(7);
        expect(await getReadyGeneration('legacy')).toBe(7);
        await clearLocalGeneration('legacy');
    });

    it('tracks blue-green live/ready generations independently', async () => {
        await clearLocalGeneration('bg');
        // Old generation fully deployed + ready + live.
        await setLocalGeneration('bg', 1);
        // New (blue) generation comes up but is not yet ready.
        await markGenerationLive('bg', 2);
        expect(await getLocalGeneration('bg')).toBe(2);
        expect(await getReadyGeneration('bg')).toBe(1);
        expect((await getLiveGenerations('bg')).sort()).toEqual([1, 2]);
        // Blue passes its readiness gate.
        await markGenerationReady('bg', 2);
        expect(await getReadyGeneration('bg')).toBe(2);
        // Old generation drained away.
        await removeLiveGeneration('bg', 1);
        expect(await getLiveGenerations('bg')).toEqual([2]);
        await clearLocalGeneration('bg');
    });
});
