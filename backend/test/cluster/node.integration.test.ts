import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { ensureSelfRegistered } from '@/cluster/registry';
import { OpType } from '@mosaiq/nsm-common/clusterOps';

// The Cluster singleton is role-static (NSM_ROLE=leader in the test env). It applies proposed ops
// directly to the source-of-truth DB and composes status from the registry.
beforeEach(async () => {
    await resetDb();
    await ensureSelfRegistered();
});

describe('cluster (leader/registry)', () => {
    it('is the leader and composes a status for the local node', async () => {
        expect(cluster.isLeader()).toBe(true);
        const status = await cluster.status();
        expect(status.leaderId).toBe(config.nodeId);
        expect(status.nodes.map((n) => n.nodeId)).toContain(config.nodeId);
        const selfHealth = status.health.find((h) => h.nodeId === config.nodeId);
        expect(selfHealth?.isLeader).toBe(true);
        expect(selfHealth?.reachable).toBe(true);
        expect(status.desiredNsmVersion).toBeNull();
    });

    it('applies a proposed op directly to the local view', async () => {
        await cluster.propose({ type: OpType.SET_DESIRED_NSM_VERSION, version: '9.9.9', artifactRef: 'v9.9.9' });
        const status = await cluster.status();
        expect(status.desiredNsmVersion).toBe('9.9.9');
    });
});
