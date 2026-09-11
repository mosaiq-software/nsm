import { describe, it, expect } from 'vitest';
import { buildTargetGroups } from '@/reconcile/promTargets';

describe('buildTargetGroups', () => {
    it('addresses each node by its stable internal hostname (IP-less) and labels by nodeId', () => {
        const groups = buildTargetGroups([{ nodeId: 'a' }, { nodeId: 'b' }], 'nsm.internal', 9100);
        expect(groups).toEqual([
            { labels: { nodeId: 'a' }, targets: ['a.nsm.internal:9100'] },
            { labels: { nodeId: 'b' }, targets: ['b.nsm.internal:9100'] },
        ]);
    });

    it('uses the provided port per job', () => {
        expect(buildTargetGroups([{ nodeId: 'a' }], 'nsm.internal', 8080)[0].targets).toEqual(['a.nsm.internal:8080']);
    });
});
