import * as fs from 'fs';
import * as path from 'path';
import { RaftNode } from '@/cluster/raft';
import { NodeInfo, Op } from '@mosaiq/nsm-common/clusterOps';

export interface TestNode {
    info: NodeInfo;
    raft: RaftNode;
    applied: { op: Op; index: number }[];
    configs: NodeInfo[][];
    dataDir: string;
}

const tmpRoot = (): string => (globalThis as any).__NSM_TMP__ as string;

// Wide random base per file-process to avoid cross-file port collisions.
let portCursor = 20000 + Math.floor(Math.random() * 30000);
const nextPort = (): number => portCursor++;

export const allocInfo = (nodeId: string): NodeInfo => ({ nodeId, address: '127.0.0.1', raftPort: nextPort(), apiPort: nextPort() });

// Build (but do not start) a RaftNode whose apply/config callbacks record into the returned TestNode.
export const createNode = (info: NodeInfo, initialMembers: NodeInfo[], startAsSingle: boolean, startingApplied = 0): TestNode => {
    const dataDir = path.join(tmpRoot(), 'raft', info.nodeId + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(dataDir, { recursive: true });
    const node: TestNode = { info, raft: undefined as any, applied: [], configs: [], dataDir };
    node.raft = new RaftNode({
        self: info,
        initialMembers,
        dataDir,
        startAsSingle,
        startingApplied,
        applyOp: (op, index) => {
            node.applied.push({ op, index });
        },
        onConfig: (members) => {
            node.configs.push(members);
        },
    });
    return node;
};

// Recreate a node on the SAME data dir (simulates a process restart).
export const restartNode = (prev: TestNode, initialMembers: NodeInfo[], startingApplied: number): TestNode => {
    const node: TestNode = { info: prev.info, raft: undefined as any, applied: [], configs: [], dataDir: prev.dataDir };
    node.raft = new RaftNode({
        self: prev.info,
        initialMembers,
        dataDir: prev.dataDir,
        startAsSingle: false,
        startingApplied,
        applyOp: (op, index) => node.applied.push({ op, index }),
        onConfig: (members) => node.configs.push(members),
    });
    return node;
};

export const waitFor = async (pred: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('waitFor timed out');
};

export const findLeaders = (nodes: TestNode[]): TestNode[] => nodes.filter((n) => n.raft.isLeader());

export const waitForSingleLeader = async (nodes: TestNode[], timeoutMs = 8000): Promise<TestNode> => {
    await waitFor(() => findLeaders(nodes).length === 1, timeoutMs);
    return findLeaders(nodes)[0];
};

export const stopAll = (nodes: TestNode[]): void => {
    for (const n of nodes) {
        try {
            n.raft.stop();
        } catch {
            /* ignore */
        }
    }
};
