import { DeploymentState } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { updateDeploymentLog } from '@/controllers/deployController';

// Owning node reports deployment progress to the leader (which stores it in the instance log).
// If this node IS the leader, write directly; otherwise POST to the leader over HTTP.
export const reportDeploymentLog = async (logId: string, status: DeploymentState, log: string): Promise<void> => {
    try {
        if (cluster.isLeader()) {
            await updateDeploymentLog(logId, status, log);
        } else {
            await postToLeader('/cluster/log', { logId, status, log });
        }
    } catch (e) {
        console.error('Failed to report deployment log:', e);
    }
};
