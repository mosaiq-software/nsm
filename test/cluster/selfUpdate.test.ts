import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true), propose: vi.fn(), members: vi.fn() } }));
vi.mock('@/persistence/clusterMetaPersistence', () => ({ getDesiredNsmVersion: vi.fn() }));
vi.mock('@/cluster/statusGossip', () => ({ getNodeHealthReports: vi.fn(() => ({})) }));
vi.mock('@/cluster/leaderClient', () => ({ postToNode: vi.fn() }));
vi.mock('@/host/exec', () => ({ execSafe: vi.fn(), execStream: vi.fn() }));

import { cluster } from '@/cluster/node';
import { getDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { getNodeHealthReports } from '@/cluster/statusGossip';
import { postToNode } from '@/cluster/leaderClient';
import { execSafe } from '@/host/exec';
import { config } from '@/config';
import { setDesiredNsmVersion, runSelfUpdateRolloutIfLeader, applyUpdateInstruction } from '@/cluster/selfUpdate';
import { OpType } from '@mosaiq/nsm-common/clusterOps';

const isLeader = cluster.isLeader as unknown as Mock;
const propose = cluster.propose as unknown as Mock;
const members = cluster.members as unknown as Mock;
const mDesired = getDesiredNsmVersion as unknown as Mock;
const mReports = getNodeHealthReports as unknown as Mock;
const mPostToNode = postToNode as unknown as Mock;
const mExec = execSafe as unknown as Mock;

beforeEach(() => {
    isLeader.mockReset().mockReturnValue(true);
    propose.mockReset();
    members.mockReset();
    mDesired.mockReset();
    mReports.mockReset().mockReturnValue({});
    mPostToNode.mockReset();
    mExec.mockReset();
});

describe('setDesiredNsmVersion', () => {
    it('proposes SET_DESIRED_NSM_VERSION', async () => {
        await setDesiredNsmVersion('2.0.0', 'v2.0.0');
        expect(propose).toHaveBeenCalledWith({ type: OpType.SET_DESIRED_NSM_VERSION, version: '2.0.0', artifactRef: 'v2.0.0' });
    });
});

describe('applyUpdateInstruction', () => {
    it('is a no-op in non-production (no host commands)', async () => {
        config.production = false;
        await applyUpdateInstruction('v2.0.0');
        expect(mExec).not.toHaveBeenCalled();
    });
});

describe('runSelfUpdateRolloutIfLeader', () => {
    it('does nothing when not the leader', async () => {
        isLeader.mockReturnValue(false);
        await runSelfUpdateRolloutIfLeader();
        expect(mPostToNode).not.toHaveBeenCalled();
    });

    it('instructs a stale follower to upgrade (followers first)', async () => {
        mDesired.mockResolvedValue({ version: 'v2', artifactRef: 'ref2' });
        members.mockReturnValue([
            { nodeId: config.nodeId, address: '127.0.0.1', raftPort: 1, apiPort: 2 },
            { nodeId: 'n1', address: '1.2.3.4', raftPort: 3, apiPort: 9 },
        ]);
        mReports.mockReturnValue({ n1: { nsmVersion: 'v1' } });
        await runSelfUpdateRolloutIfLeader();
        expect(mPostToNode).toHaveBeenCalledWith('1.2.3.4', 9, '/cluster/apply-update', { version: 'v2', artifactRef: 'ref2' });
    });
});
