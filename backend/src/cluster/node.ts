import { Op } from '@mosaiq/nsm-common/clusterOps';
import { ClusterStatus, NodeHealth } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { getDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { applyOp } from './stateMachine';
import { getNodeHealthReports } from './statusGossip';

// Thin cluster facade. There is no election and no failover: the leader is statically declared
// via NSM_ROLE and its SQLite DB is the sole source of truth. Followers pull desired state and
// push status/logs; writes are forwarded to the leader by the HTTP layer.
class Cluster {
    isLeader(): boolean {
        return config.role === 'leader';
    }

    // The one stable anchor. On the leader this points at itself.
    leaderAddress(): string | null {
        return config.leaderAddress || null;
    }

    // Leader-only: apply a state mutation directly to the source-of-truth DB.
    async propose(op: Op): Promise<void> {
        if (!this.isLeader()) throw new Error('propose() may only run on the leader');
        await applyOp(op);
    }

    async status(): Promise<ClusterStatus> {
        const nodes = await getAllNodesModel();
        const reports = getNodeHealthReports();
        const health: NodeHealth[] = nodes.map((n) => {
            const r = reports[n.nodeId];
            return {
                nodeId: n.nodeId,
                reachable: r ? Date.now() - r.ts < 60000 : n.isLeader,
                nsmVersion: r?.nsmVersion || (n.isLeader ? config.commit || config.version : 'unknown'),
                isLeader: n.isLeader,
                lastSeen: r?.ts ?? n.lastSeen ?? 0,
            };
        });
        const leader = nodes.find((n) => n.isLeader);
        return {
            leaderId: leader?.nodeId ?? null,
            nodes,
            health,
            desiredNsmVersion: (await getDesiredNsmVersion())?.version ?? null,
        };
    }

    stop() {
        /* nothing to tear down without raft */
    }
}

export const cluster = new Cluster();
