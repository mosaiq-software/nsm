import { NodeInfo, Op } from '@mosaiq/nsm-common/clusterOps';
import { ClusterNode, ClusterStatus, NodeHealth } from '@mosaiq/nsm-common/types';
import { config, loadClusterFile, saveClusterFile, selfNodeInfo } from '@/config';
import { getLastAppliedIndex } from '@/persistence/clusterMetaPersistence';
import { getDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { getAllNodesModel, upsertNodeModel, deleteNodeModel } from '@/persistence/nodePersistence';
import { applyOp } from './stateMachine';
import { NotLeaderError, RaftNode } from './raft';
import { getNodeHealthReports } from './statusGossip';

type LeaderListener = (isLeader: boolean) => void;

class Cluster {
    private raft?: RaftNode;
    private leaderListeners: LeaderListener[] = [];

    async init(): Promise<void> {
        const cf = loadClusterFile();
        const initialMembers = cf.nodes.length ? cf.nodes : [selfNodeInfo()];
        const startingApplied = await getLastAppliedIndex();
        const startAsSingle = config.bootstrapMode === 'init';

        this.raft = new RaftNode({
            self: selfNodeInfo(),
            initialMembers,
            dataDir: config.raftDataDir,
            startAsSingle,
            startingApplied,
            applyOp: (op, index) => applyOp(op, index),
            onConfig: (members) => this.onConfig(members),
            onLeader: (isLeader) => this.leaderListeners.forEach((l) => l(isLeader)),
        });
        await this.raft.start();
        // Ensure our own node row exists in the view for status reporting.
        await this.onConfig(this.raft.members());
    }

    private async onConfig(members: NodeInfo[]): Promise<void> {
        for (const m of members) await upsertNodeModel({ ...m, voter: true });
        const existing = await getAllNodesModel();
        for (const e of existing) if (!members.find((m) => m.nodeId === e.nodeId)) await deleteNodeModel(e.nodeId);
        const cf = loadClusterFile();
        saveClusterFile({ ...cf, nodes: members, vip: config.vip, vrrpRouterId: config.vrrpRouterId });
    }

    onLeaderChange(listener: LeaderListener) {
        this.leaderListeners.push(listener);
    }

    isLeader(): boolean {
        return this.raft?.isLeader() ?? false;
    }

    leaderAddress(): string | null {
        return this.raft?.leaderAddress() ?? null;
    }

    members(): NodeInfo[] {
        return this.raft?.members() ?? [];
    }

    async propose(op: Op): Promise<void> {
        if (!this.raft) throw new Error('Cluster not initialized');
        await this.raft.propose(op);
    }

    async addNode(n: NodeInfo): Promise<void> {
        if (!this.raft) throw new Error('Cluster not initialized');
        await this.raft.addLearner(n);
    }

    async removeNode(nodeId: string): Promise<void> {
        if (!this.raft) throw new Error('Cluster not initialized');
        await this.raft.removeNode(nodeId);
    }

    async status(): Promise<ClusterStatus> {
        const nodes: ClusterNode[] = (this.members() || []).map((m) => ({ ...m, voter: true }));
        const reports = getNodeHealthReports();
        const health: NodeHealth[] = nodes.map((n) => {
            const r = reports[n.nodeId];
            return {
                nodeId: n.nodeId,
                reachable: r ? Date.now() - r.ts < 60000 : n.nodeId === config.nodeId,
                nsmVersion: r?.nsmVersion || (n.nodeId === config.nodeId ? config.version : 'unknown'),
                isLeader: this.raft?.leaderId_() === n.nodeId,
                vipHolder: r?.vipHolder ?? false,
                lastSeen: r?.ts ?? (n.nodeId === config.nodeId ? Date.now() : 0),
            };
        });
        const desired = await getDesiredNsmVersion();
        return {
            leaderId: this.raft?.leaderId_() ?? null,
            term: this.raft?.term() ?? 0,
            nodes,
            health,
            desiredNsmVersion: desired?.version ?? null,
            vip: config.vip || null,
        };
    }

    stop() {
        this.raft?.stop();
    }
}

export const cluster = new Cluster();
export { NotLeaderError };
