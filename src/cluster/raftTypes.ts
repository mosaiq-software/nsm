import { NodeInfo, Op } from '@mosaiq/nsm-common/clusterOps';

export type EntryType = 'op' | 'config' | 'noop';

export interface LogEntry {
    index: number;
    term: number;
    type: EntryType;
    op?: Op; // when type === 'op'
    config?: NodeInfo[]; // when type === 'config' (full membership after change)
}

// === Wire messages (newline-delimited JSON over TCP) ===
export type RaftMessage = RequestVoteReq | RequestVoteResp | AppendEntriesReq | AppendEntriesResp;

export interface RequestVoteReq {
    kind: 'RequestVote';
    reqId: string;
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
}
export interface RequestVoteResp {
    kind: 'RequestVoteResp';
    reqId: string;
    term: number;
    voteGranted: boolean;
}
export interface AppendEntriesReq {
    kind: 'AppendEntries';
    reqId: string;
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
}
export interface AppendEntriesResp {
    kind: 'AppendEntriesResp';
    reqId: string;
    term: number;
    success: boolean;
    matchIndex: number; // highest index known-replicated on the follower (on success)
    conflictIndex?: number; // hint for fast backtracking (on failure)
}
