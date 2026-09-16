import { DeploymentState } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { updateDeploymentLog, promoteDeployment } from '@/controllers/deployController';
import { areaLog } from '@/utils/log';

const reportLog = areaLog('deploy');

// Owning node reports deployment progress to the leader (which stores it in the instance log).
// If this node IS the leader, write directly; otherwise POST to the leader over HTTP.
export const reportDeploymentLog = async (logId: string, status: DeploymentState, log: string): Promise<void> => {
    try {
        if (cluster.isLeader()) {
            await updateDeploymentLog(logId, status, log);
        } else {
            await postToLeader('/cluster/log', { logId, status, log });
        }
    } catch (e: any) {
        reportLog.error({ action: 'report_log_failed', logId, status, err: e?.message }, 'failed to report deployment log');
    }
};

// After a new (blue) generation passes its readiness gate, the owning node tells the leader it is
// ready so the leader can promote it (flip nginx to the new ports). On the leader this promotes
// directly; on a follower it POSTs the secret-gated /cluster/deploy-ready endpoint.
export const reportDeployReady = async (projectId: string, generation: number, nodeId: string): Promise<void> => {
    try {
        reportLog.info({ action: 'deploy_ready_reported', projectId, generation, nodeId, isLeader: cluster.isLeader() }, `reported generation ${generation} ready for ${projectId}`);
        if (cluster.isLeader()) {
            await promoteDeployment(projectId, generation, nodeId);
        } else {
            await postToLeader('/cluster/deploy-ready', { projectId, generation, nodeId });
        }
    } catch (e: any) {
        reportLog.error({ action: 'report_ready_failed', projectId, generation, err: e?.message }, 'failed to report deployment ready');
    }
};
