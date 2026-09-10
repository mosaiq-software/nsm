import { NodeInfo, Op } from '@mosaiq/nsm-common/clusterOps';
import { RaftLog } from './raftLog';
import { RaftTransport } from './transport';
import { AppendEntriesReq, AppendEntriesResp, LogEntry, RaftMessage, RequestVoteReq, RequestVoteResp } from './raftTypes';

export interface RaftOptions {
    self: NodeInfo;
    initialMembers: NodeInfo[];
    dataDir: string;
    startAsSingle: boolean;
    startingApplied: number;
    applyOp: (op: Op, index: number) => Promise<void> | void;
    onConfig?: (members: NodeInfo[]) => Promise<void> | void;
    onLeader?: (isLeader: boolean) => void;
}

export class NotLeaderError extends Error {
    leaderHint: string | null;
    constructor(leaderHint: string | null) {
        super('Not the leader');
        this.name = 'NotLeaderError';
        this.leaderHint = leaderHint;
    }
}

type Role = 'follower' | 'candidate' | 'leader';

// Timers are overridable via env (defaults preserved) so tests can run a fast, stable cluster.
const envNum = (name: string, d: number) => (process.env[name] && !isNaN(Number(process.env[name])) ? Number(process.env[name]) : d);
const ELECTION_MIN = envNum('RAFT_ELECTION_MIN_MS', 1200);
const ELECTION_MAX = envNum('RAFT_ELECTION_MAX_MS', 2400);
const HEARTBEAT_MS = envNum('RAFT_HEARTBEAT_MS', 350);

export class RaftNode {
    private opts: RaftOptions;
    private log: RaftLog;
    private transport: RaftTransport;

    private role: Role = 'follower';
    private leaderId: string | null = null;
    private commitIndex = 0;
    private lastApplied = 0;

    private nextIndex = new Map<string, number>();
    private matchIndex = new Map<string, number>();

    private electionTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;
    private applyWaiters: { index: number; resolve: () => void }[] = [];
    private applying = false;

    constructor(opts: RaftOptions) {
        this.opts = opts;
        this.log = new RaftLog(opts.dataDir);
        this.lastApplied = opts.startingApplied;
        this.commitIndex = opts.startingApplied;
        this.transport = new RaftTransport((msg) => this.handleMessage(msg));
    }

    async start(): Promise<void> {
        await this.transport.listen(this.opts.self.raftPort, '0.0.0.0');
        if (this.log.allEntries().length === 0 && this.opts.startAsSingle) {
            // Bootstrap a brand-new single-node cluster: seed the initial membership config.
            const members = this.opts.initialMembers.length ? this.opts.initialMembers : [this.opts.self];
            this.log.setHardState({ currentTerm: 1 });
            this.log.append({ term: 1, type: 'config', config: members });
            await this.opts.onConfig?.(members);
        }
        this.resetElectionTimer();
        console.log(`[raft] node ${this.opts.self.nodeId} started on :${this.opts.self.raftPort} (members=${this.members().map((m) => m.nodeId).join(',')})`);
    }

    // === Public interface (matches plan Section 4.5) ===
    isLeader(): boolean {
        return this.role === 'leader';
    }

    term(): number {
        return this.log.getHardState().currentTerm;
    }

    leaderId_(): string | null {
        return this.leaderId;
    }

    leaderAddress(): string | null {
        if (!this.leaderId) return null;
        const n = this.members().find((m) => m.nodeId === this.leaderId);
        return n ? `http://${n.address}:${n.apiPort}` : null;
    }

    members(): NodeInfo[] {
        return this.log.latestConfig() ?? this.opts.initialMembers;
    }

    private peers(): NodeInfo[] {
        return this.members().filter((m) => m.nodeId !== this.opts.self.nodeId);
    }

    async propose(op: Op): Promise<void> {
        if (this.role !== 'leader') throw new NotLeaderError(this.leaderAddress());
        const entry = this.log.append({ term: this.term(), type: 'op', op });
        this.replicateNow();
        await this.waitForApplied(entry.index);
    }

    // Membership: leader appends a new config entry (single-node change at a time).
    // Does NOT wait for commit: the new member usually isn't running yet at join time, so
    // waiting would deadlock (the enlarged quorum can't be reached until it comes up).
    async addLearner(n: NodeInfo): Promise<void> {
        if (this.role !== 'leader') throw new NotLeaderError(this.leaderAddress());
        const members = this.members().slice();
        if (!members.find((m) => m.nodeId === n.nodeId)) members.push(n);
        this.log.append({ term: this.term(), type: 'config', config: members });
        await this.opts.onConfig?.(members);
        this.nextIndex.set(n.nodeId, 1); // replay whole log to the fresh node
        this.matchIndex.set(n.nodeId, 0);
        this.replicateNow();
    }

    async promote(_nodeId: string): Promise<void> {
        // Simplified model: added nodes are immediately voters, so promotion is a no-op.
        return;
    }

    async removeNode(nodeId: string): Promise<void> {
        if (this.role !== 'leader') throw new NotLeaderError(this.leaderAddress());
        const members = this.members().filter((m) => m.nodeId !== nodeId);
        this.log.append({ term: this.term(), type: 'config', config: members });
        await this.opts.onConfig?.(members);
        this.replicateNow();
    }

    // === Timers ===
    private resetElectionTimer() {
        if (this.electionTimer) clearTimeout(this.electionTimer);
        const timeout = ELECTION_MIN + Math.floor(Math.random() * (ELECTION_MAX - ELECTION_MIN));
        this.electionTimer = setTimeout(() => this.startElection(), timeout);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
    }

    // === Elections ===
    private async startElection() {
        if (this.role === 'leader') return;
        // A single-node cluster elects itself immediately.
        this.role = 'candidate';
        const newTerm = this.term() + 1;
        this.log.setHardState({ currentTerm: newTerm, votedFor: this.opts.self.nodeId });
        this.leaderId = null;
        this.resetElectionTimer();

        const peers = this.peers();
        let votes = 1; // self
        const majority = Math.floor(this.members().length / 2) + 1;
        if (votes >= majority) return this.becomeLeader();

        const req: RequestVoteReq = {
            kind: 'RequestVote',
            reqId: crypto.randomUUID(),
            term: newTerm,
            candidateId: this.opts.self.nodeId,
            lastLogIndex: this.log.lastIndex(),
            lastLogTerm: this.log.lastTerm(),
        };

        await Promise.all(
            peers.map(async (peer) => {
                const resp = (await this.transport.send(peer, req)) as RequestVoteResp | null;
                if (!resp || resp.kind !== 'RequestVoteResp') return;
                if (resp.term > this.term()) {
                    this.stepDown(resp.term);
                    return;
                }
                if (this.role === 'candidate' && resp.term === this.term() && resp.voteGranted) {
                    votes++;
                    if (votes >= majority) this.becomeLeader();
                }
            })
        );
    }

    private becomeLeader() {
        if (this.role === 'leader') return;
        this.role = 'leader';
        this.leaderId = this.opts.self.nodeId;
        // A leader does not run an election timer; it asserts leadership via heartbeats.
        if (this.electionTimer) clearTimeout(this.electionTimer);
        console.log(`[raft] ${this.opts.self.nodeId} became LEADER for term ${this.term()}`);
        const last = this.log.lastIndex();
        for (const p of this.peers()) {
            this.nextIndex.set(p.nodeId, last + 1);
            this.matchIndex.set(p.nodeId, 0);
        }
        // Commit-safety no-op entry for the new term.
        this.log.append({ term: this.term(), type: 'noop' });
        this.opts.onLeader?.(true);
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => this.replicateNow(), HEARTBEAT_MS);
        this.replicateNow();
    }

    private stepDown(term: number) {
        if (term > this.term()) this.log.setHardState({ currentTerm: term, votedFor: null });
        if (this.role === 'leader') this.opts.onLeader?.(false);
        this.role = 'follower';
        this.stopHeartbeat();
        this.resetElectionTimer();
    }

    // === Replication (leader) ===
    private replicateNow() {
        if (this.role !== 'leader') return;
        for (const peer of this.peers()) void this.sendAppendEntries(peer);
        this.maybeAdvanceCommit();
    }

    private async sendAppendEntries(peer: NodeInfo) {
        const ni = this.nextIndex.get(peer.nodeId) ?? this.log.lastIndex() + 1;
        const prevLogIndex = ni - 1;
        const prevLogTerm = this.log.termAt(prevLogIndex);
        const entries = this.log.entriesFrom(prevLogIndex);
        const req: AppendEntriesReq = {
            kind: 'AppendEntries',
            reqId: crypto.randomUUID(),
            term: this.term(),
            leaderId: this.opts.self.nodeId,
            prevLogIndex,
            prevLogTerm,
            entries,
            leaderCommit: this.commitIndex,
        };
        const resp = (await this.transport.send(peer, req)) as AppendEntriesResp | null;
        if (!resp || resp.kind !== 'AppendEntriesResp') return;
        if (resp.term > this.term()) return this.stepDown(resp.term);
        if (this.role !== 'leader') return;
        if (resp.success) {
            this.matchIndex.set(peer.nodeId, resp.matchIndex);
            this.nextIndex.set(peer.nodeId, resp.matchIndex + 1);
            this.maybeAdvanceCommit();
        } else {
            const back = resp.conflictIndex && resp.conflictIndex > 0 ? resp.conflictIndex : Math.max(1, (this.nextIndex.get(peer.nodeId) ?? 1) - 1);
            this.nextIndex.set(peer.nodeId, back);
        }
    }

    private maybeAdvanceCommit() {
        if (this.role !== 'leader') return;
        const last = this.log.lastIndex();
        for (let n = last; n > this.commitIndex; n--) {
            if (this.log.termAt(n) !== this.term()) continue;
            let count = 1; // self
            for (const p of this.peers()) if ((this.matchIndex.get(p.nodeId) ?? 0) >= n) count++;
            if (count >= Math.floor(this.members().length / 2) + 1) {
                this.commitIndex = n;
                break;
            }
        }
        void this.applyCommitted();
    }

    // === Message handling (server side) ===
    private async handleMessage(msg: RaftMessage): Promise<RaftMessage | null> {
        if (msg.kind === 'RequestVote') return this.handleRequestVote(msg);
        if (msg.kind === 'AppendEntries') return this.handleAppendEntries(msg);
        return null;
    }

    private handleRequestVote(req: RequestVoteReq): RequestVoteResp {
        const resp = (voteGranted: boolean): RequestVoteResp => ({ kind: 'RequestVoteResp', reqId: req.reqId, term: this.term(), voteGranted });
        if (req.term < this.term()) return resp(false);
        if (req.term > this.term()) this.stepDown(req.term);
        const hs = this.log.getHardState();
        const upToDate = req.lastLogTerm > this.log.lastTerm() || (req.lastLogTerm === this.log.lastTerm() && req.lastLogIndex >= this.log.lastIndex());
        if ((hs.votedFor === null || hs.votedFor === req.candidateId) && upToDate) {
            this.log.setHardState({ votedFor: req.candidateId });
            this.resetElectionTimer();
            return resp(true);
        }
        return resp(false);
    }

    private async handleAppendEntries(req: AppendEntriesReq): Promise<AppendEntriesResp> {
        const fail = (conflictIndex?: number): AppendEntriesResp => ({ kind: 'AppendEntriesResp', reqId: req.reqId, term: this.term(), success: false, matchIndex: 0, conflictIndex });
        if (req.term < this.term()) return fail();
        if (req.term > this.term() || this.role !== 'follower') this.stepDown(req.term);
        this.leaderId = req.leaderId;
        this.resetElectionTimer();

        // Log consistency check.
        if (req.prevLogIndex > 0) {
            const prev = this.log.entryAt(req.prevLogIndex);
            if (!prev) return fail(this.log.lastIndex() + 1);
            if (prev.term !== req.prevLogTerm) return fail(req.prevLogIndex);
        }

        if (req.entries.length) {
            const hadConfig = this.log.latestConfig();
            this.log.appendFromLeader(req.prevLogIndex, req.entries);
            const newConfig = this.log.latestConfig();
            if (newConfig && newConfig !== hadConfig) await this.opts.onConfig?.(newConfig);
        }

        const matchIndex = req.prevLogIndex + req.entries.length;
        if (req.leaderCommit > this.commitIndex) {
            this.commitIndex = Math.min(req.leaderCommit, this.log.lastIndex());
            void this.applyCommitted();
        }
        return { kind: 'AppendEntriesResp', reqId: req.reqId, term: this.term(), success: true, matchIndex };
    }

    // === Apply loop ===
    private async applyCommitted() {
        if (this.applying) return;
        this.applying = true;
        try {
            while (this.lastApplied < this.commitIndex) {
                const next = this.lastApplied + 1;
                const entry = this.log.entryAt(next) as LogEntry | undefined;
                if (!entry) break;
                if (entry.type === 'op' && entry.op) {
                    await this.opts.applyOp(entry.op, entry.index);
                } else if (entry.type === 'config' && entry.config) {
                    await this.opts.onConfig?.(entry.config);
                }
                this.lastApplied = next;
                this.resolveWaiters(next);
            }
        } finally {
            this.applying = false;
        }
    }

    private waitForApplied(index: number): Promise<void> {
        if (this.lastApplied >= index) return Promise.resolve();
        return new Promise((resolve) => {
            this.applyWaiters.push({ index, resolve });
            // Safety timeout so a stalled proposal never hangs a request forever.
            setTimeout(() => this.resolveWaiters(index), 30000);
        });
    }

    private resolveWaiters(appliedIndex: number) {
        this.applyWaiters = this.applyWaiters.filter((w) => {
            if (w.index <= appliedIndex) {
                w.resolve();
                return false;
            }
            return true;
        });
    }

    stop() {
        if (this.electionTimer) clearTimeout(this.electionTimer);
        this.stopHeartbeat();
        this.transport.close();
    }
}
