import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn() } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn() }));
vi.mock('@/controllers/deployController', () => ({ updateDeploymentLog: vi.fn() }));

import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { updateDeploymentLog } from '@/controllers/deployController';
import { reportDeploymentLog } from '@/reconcile/report';
import { DeploymentState } from '@mosaiq/nsm-common/types';

const isLeader = cluster.isLeader as unknown as Mock;
const mPost = postToLeader as unknown as Mock;
const mUpdate = updateDeploymentLog as unknown as Mock;

beforeEach(() => {
    isLeader.mockReset();
    mPost.mockReset();
    mUpdate.mockReset();
});

describe('reportDeploymentLog', () => {
    it('writes directly when this node is the leader', async () => {
        isLeader.mockReturnValue(true);
        await reportDeploymentLog('log1', DeploymentState.DEPLOYED, 'ok\n');
        expect(mUpdate).toHaveBeenCalledWith('log1', DeploymentState.DEPLOYED, 'ok\n');
        expect(mPost).not.toHaveBeenCalled();
    });

    it('posts to the leader when this node is a follower', async () => {
        isLeader.mockReturnValue(false);
        await reportDeploymentLog('log1', DeploymentState.DEPLOYING, 'progress\n');
        expect(mPost).toHaveBeenCalledWith('/cluster/log', { logId: 'log1', status: DeploymentState.DEPLOYING, log: 'progress\n' });
        expect(mUpdate).not.toHaveBeenCalled();
    });
});
