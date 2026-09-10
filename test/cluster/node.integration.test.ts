import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb } from '../helpers/db';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { waitFor } from '../helpers/raftCluster';

// Exercises the real Cluster singleton wiring raft + state machine + status composition.
beforeAll(async () => {
    await resetDb();
    config.bootstrapMode = 'init'; // seed a single-node cluster so it self-elects deterministically
    await cluster.init();
    await waitFor(() => cluster.isLeader(), 8000);
});

afterAll(() => {
    cluster.stop();
});

describe('cluster.init + status', () => {
    it('becomes leader and composes a cluster status for the local node', async () => {
        expect(cluster.isLeader()).toBe(true);
        const status = await cluster.status();
        expect(status.leaderId).toBe(config.nodeId);
        expect(status.term).toBeGreaterThan(0);
        expect(status.nodes.map((n) => n.nodeId)).toContain(config.nodeId);
        const selfHealth = status.health.find((h) => h.nodeId === config.nodeId);
        expect(selfHealth?.isLeader).toBe(true);
        expect(selfHealth?.reachable).toBe(true);
        expect(status.desiredNsmVersion).toBeNull();
    });

    it('applies a proposed op to the local materialized view', async () => {
        await cluster.propose({ type: (await import('@mosaiq/nsm-common/clusterOps')).OpType.SET_DESIRED_NSM_VERSION, version: '9.9.9', artifactRef: 'v9.9.9' });
        const status = await cluster.status();
        expect(status.desiredNsmVersion).toBe('9.9.9');
    });
});
