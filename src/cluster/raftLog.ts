import * as fs from 'fs';
import { LogEntry } from './raftTypes';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

// Persistent Raft log + hard state. Kept fully on disk (no snapshot-install RPC): the entire
// log is retained so a lagging or newly-joined node can be caught up by replaying from the start.
export interface HardState {
    currentTerm: number;
    votedFor: string | null;
}

export class RaftLog {
    private dir: string;
    private logPath: string;
    private statePath: string;
    private entries: LogEntry[] = [];
    private hard: HardState = { currentTerm: 0, votedFor: null };

    constructor(dir: string) {
        this.dir = dir;
        this.logPath = `${dir}/log.json`;
        this.statePath = `${dir}/state.json`;
        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }

    private load() {
        try {
            this.entries = JSON.parse(fs.readFileSync(this.logPath, 'utf-8'));
        } catch {
            this.entries = [];
        }
        try {
            this.hard = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
        } catch {
            this.hard = { currentTerm: 0, votedFor: null };
        }
    }

    private persistLog() {
        fs.writeFileSync(this.logPath, JSON.stringify(this.entries));
    }

    private persistState() {
        fs.writeFileSync(this.statePath, JSON.stringify(this.hard));
    }

    getHardState(): HardState {
        return { ...this.hard };
    }

    setHardState(hs: Partial<HardState>) {
        this.hard = { ...this.hard, ...hs };
        this.persistState();
    }

    lastIndex(): number {
        return this.entries.length ? this.entries[this.entries.length - 1].index : 0;
    }

    lastTerm(): number {
        return this.entries.length ? this.entries[this.entries.length - 1].term : 0;
    }

    termAt(index: number): number {
        if (index === 0) return 0;
        const e = this.entries[index - 1];
        return e ? e.term : 0;
    }

    entryAt(index: number): LogEntry | undefined {
        if (index <= 0) return undefined;
        return this.entries[index - 1];
    }

    // Entries with index > fromIndex (used to build AppendEntries payloads).
    entriesFrom(fromIndex: number): LogEntry[] {
        return this.entries.slice(fromIndex);
    }

    append(entry: Omit<LogEntry, 'index'>): LogEntry {
        const index = this.lastIndex() + 1;
        const full: LogEntry = { ...entry, index };
        this.entries.push(full);
        this.persistLog();
        return full;
    }

    // Truncate any conflicting suffix then append the given entries (follower path).
    appendFromLeader(prevLogIndex: number, entries: LogEntry[]) {
        // Drop anything after prevLogIndex that conflicts.
        for (const e of entries) {
            const existing = this.entryAt(e.index);
            if (existing && existing.term !== e.term) {
                this.entries = this.entries.slice(0, e.index - 1);
            }
            if (!this.entryAt(e.index)) {
                this.entries.push(e);
            }
        }
        this.persistLog();
    }

    // The most recent membership config in the log (or null if none yet committed to the log).
    latestConfig(): NodeInfo[] | null {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i].type === 'config' && this.entries[i].config) {
                return this.entries[i].config!;
            }
        }
        return null;
    }

    allEntries(): LogEntry[] {
        return this.entries;
    }
}
