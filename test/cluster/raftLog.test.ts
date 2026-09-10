import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { RaftLog } from '@/cluster/raftLog';
import { NodeInfo } from '@mosaiq/nsm-common/clusterOps';

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nsm-raftlog-'));

describe('RaftLog', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkDir();
    });

    it('appends entries with increasing indices and reports last index/term', () => {
        const log = new RaftLog(dir);
        expect(log.lastIndex()).toBe(0);
        log.append({ term: 1, type: 'noop' });
        const e2 = log.append({ term: 2, type: 'noop' });
        expect(e2.index).toBe(2);
        expect(log.lastIndex()).toBe(2);
        expect(log.lastTerm()).toBe(2);
        expect(log.termAt(1)).toBe(1);
        expect(log.entryAt(2)?.term).toBe(2);
    });

    it('persists log and hard state across reloads', () => {
        const log = new RaftLog(dir);
        log.setHardState({ currentTerm: 7, votedFor: 'node-x' });
        log.append({ term: 7, type: 'noop' });
        const reloaded = new RaftLog(dir);
        expect(reloaded.getHardState()).toEqual({ currentTerm: 7, votedFor: 'node-x' });
        expect(reloaded.lastIndex()).toBe(1);
        expect(reloaded.lastTerm()).toBe(7);
    });

    it('appendFromLeader truncates a conflicting suffix then appends', () => {
        const log = new RaftLog(dir);
        log.append({ term: 1, type: 'noop' }); // idx1
        log.append({ term: 1, type: 'noop' }); // idx2 (term 1)
        // Leader says idx2 should be term 2 -> conflict, truncate idx2 and replace.
        log.appendFromLeader(1, [{ index: 2, term: 2, type: 'noop' }]);
        expect(log.lastIndex()).toBe(2);
        expect(log.termAt(2)).toBe(2);
    });

    it('tracks the latest membership config', () => {
        const log = new RaftLog(dir);
        const members1: NodeInfo[] = [{ nodeId: 'a', address: '1', raftPort: 1, apiPort: 2 }];
        const members2: NodeInfo[] = [...members1, { nodeId: 'b', address: '2', raftPort: 3, apiPort: 4 }];
        expect(log.latestConfig()).toBeNull();
        log.append({ term: 1, type: 'config', config: members1 });
        log.append({ term: 1, type: 'op' });
        log.append({ term: 1, type: 'config', config: members2 });
        expect(log.latestConfig()).toEqual(members2);
    });

    it('entriesFrom returns the tail after a given index', () => {
        const log = new RaftLog(dir);
        log.append({ term: 1, type: 'noop' });
        log.append({ term: 1, type: 'noop' });
        log.append({ term: 1, type: 'noop' });
        expect(log.entriesFrom(1).map((e) => e.index)).toEqual([2, 3]);
    });
});
