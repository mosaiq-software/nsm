import { describe, it, expect, afterEach } from 'vitest';
import { allocInfo, createNode, restartNode, stopAll, TestNode, waitFor, waitForSingleLeader } from '../helpers/raftCluster';
import { RaftLog } from '@/cluster/raftLog';
import { NotLeaderError } from '@/cluster/raft';
import { Op, OpType } from '@mosaiq/nsm-common/clusterOps';

const op = (v: string): Op => ({ type: OpType.SET_DESIRED_NSM_VERSION, version: v, artifactRef: v });
const appliedVersions = (n: TestNode) => n.applied.map((a) => (a.op as any).version);

let spawned: TestNode[] = [];
const track = (n: TestNode) => {
    spawned.push(n);
    return n;
};
afterEach(() => {
    stopAll(spawned);
    spawned = [];
});

describe('raft integration', () => {
    it('single-node bootstrap elects itself leader', async () => {
        const info = allocInfo('solo');
        const node = track(createNode(info, [info], true));
        await node.raft.start();
        await waitFor(() => node.raft.isLeader());
        expect(node.raft.isLeader()).toBe(true);
    });

    it('3-node cluster elects exactly one leader, replicates proposals, rejects follower writes', async () => {
        const infos = [allocInfo('a'), allocInfo('b'), allocInfo('c')];
        const nodes = infos.map((i) => track(createNode(i, infos, false)));
        await Promise.all(nodes.map((n) => n.raft.start()));

        const leader = await waitForSingleLeader(nodes);
        const followers = nodes.filter((n) => n !== leader);
        await waitFor(() => followers.every((f) => f.raft.leaderId_() !== null));

        await leader.raft.propose(op('v1'));
        await waitFor(() => nodes.every((n) => appliedVersions(n).includes('v1')));
        expect(nodes.every((n) => appliedVersions(n).includes('v1'))).toBe(true);

        let err: unknown;
        try {
            await followers[0].raft.propose(op('nope'));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(NotLeaderError);
        expect((err as NotLeaderError).leaderHint).toContain(String(leader.info.apiPort));
    });

    it('adds a fresh learner that catches up the full log', async () => {
        const a = allocInfo('a');
        const leaderNode = track(createNode(a, [a], true));
        await leaderNode.raft.start();
        await waitFor(() => leaderNode.raft.isLeader());
        await leaderNode.raft.propose(op('v1'));

        const b = allocInfo('b');
        const learner = track(createNode(b, [a, b], false));
        await leaderNode.raft.addLearner(b);
        await learner.raft.start();

        await waitFor(() => learner.raft.members().length === 2 && appliedVersions(learner).includes('v1'), 8000);
        expect(appliedVersions(learner)).toContain('v1');

        // New proposals now replicate to both.
        await leaderNode.raft.propose(op('v2'));
        await waitFor(() => appliedVersions(learner).includes('v2'));
        expect(appliedVersions(learner)).toContain('v2');
    });

    it('fails over to a new leader when the leader stops, and still commits (quorum 2/3)', async () => {
        const infos = [allocInfo('a'), allocInfo('b'), allocInfo('c')];
        const nodes = infos.map((i) => track(createNode(i, infos, false)));
        await Promise.all(nodes.map((n) => n.raft.start()));
        const leader = await waitForSingleLeader(nodes);
        await leader.raft.propose(op('v1'));
        await waitFor(() => nodes.every((n) => appliedVersions(n).includes('v1')));

        leader.raft.stop();
        const survivors = nodes.filter((n) => n !== leader);
        const newLeader = await waitForSingleLeader(survivors, 10000);
        expect(newLeader).not.toBe(leader);

        await newLeader.raft.propose(op('v2'));
        await waitFor(() => survivors.every((n) => appliedVersions(n).includes('v2')));
        expect(survivors.every((n) => appliedVersions(n).includes('v2'))).toBe(true);
    });

    it('repairs a follower that missed entries while partitioned', async () => {
        const infos = [allocInfo('a'), allocInfo('b'), allocInfo('c')];
        const nodes = infos.map((i) => track(createNode(i, infos, false)));
        await Promise.all(nodes.map((n) => n.raft.start()));
        const leader = await waitForSingleLeader(nodes);
        const target = nodes.find((n) => n !== leader)!;

        // Partition `target` by stopping it, then commit entries with the remaining quorum.
        target.raft.stop();
        await leader.raft.propose(op('v1'));
        await leader.raft.propose(op('v2'));

        // Bring the follower back on the same data dir; leader backtracks nextIndex and repairs it.
        const revived = track(restartNode(target, infos, 0));
        await revived.raft.start();
        await waitFor(() => appliedVersions(revived).includes('v1') && appliedVersions(revived).includes('v2'), 10000);
        expect(appliedVersions(revived)).toEqual(expect.arrayContaining(['v1', 'v2']));
    });

    it('restart preserves persisted term/log and does not re-apply committed entries', async () => {
        const a = allocInfo('a');
        const node = track(createNode(a, [a], true));
        await node.raft.start();
        await waitFor(() => node.raft.isLeader());
        await node.raft.propose(op('v1'));
        node.raft.stop();

        // Determine committed length from the persisted log (mirrors clusterMeta lastApplied).
        const persisted = new RaftLog(node.dataDir);
        const committedLen = persisted.allEntries().length;
        expect(persisted.getHardState().currentTerm).toBeGreaterThan(0);
        expect(persisted.getHardState().votedFor).toBe('a');

        const revived = track(restartNode(node, [a], committedLen));
        await revived.raft.start();
        await waitFor(() => revived.raft.isLeader());
        // v1 was already applied before the restart, so it must NOT be applied again.
        expect(appliedVersions(revived)).not.toContain('v1');

        await revived.raft.propose(op('v2'));
        await waitFor(() => appliedVersions(revived).includes('v2'));
        expect(appliedVersions(revived)).toContain('v2');
    });
});
