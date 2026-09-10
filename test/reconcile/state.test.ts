import { describe, it, expect } from 'vitest';
import { getLocalGeneration, setLocalGeneration, clearLocalGeneration, listLocalProjects } from '@/reconcile/state';

describe('local generation state', () => {
    it('returns null for an unknown project', async () => {
        expect(await getLocalGeneration('unknown')).toBeNull();
    });

    it('sets, reads, lists and clears generation markers', async () => {
        await setLocalGeneration('p1', 4);
        await setLocalGeneration('p2', 9);
        expect(await getLocalGeneration('p1')).toBe(4);
        expect((await listLocalProjects()).sort()).toEqual(['p1', 'p2']);
        await clearLocalGeneration('p1');
        expect(await getLocalGeneration('p1')).toBeNull();
    });
});
