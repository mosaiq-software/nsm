import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { sudo } from '@/host/privilege';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { getDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { cluster } from './node';
import { getNodeHealthReports } from './statusGossip';
import { areaLog } from '@/utils/log';

const updateLog = areaLog('selfUpdate');

// === CI webhook entry (leader) ===
export const setDesiredNsmVersion = async (version: string, artifactRef: string): Promise<void> => {
    await cluster.propose({ type: OpType.SET_DESIRED_NSM_VERSION, version, artifactRef });
    updateLog.info({ action: 'desired_version_set', version, artifactRef }, `desired NSM version set to ${version}`);
};

// === Node side: apply the new version to THIS host, then restart via systemd ===
// systemd Restart=always brings nsmd back on the new code. Leader coordinates ordering.
const applyVersionLocally = async (artifactRef: string): Promise<void> => {
    if (!config.production) {
        updateLog.info({ action: 'apply_version_skipped_dev', artifactRef }, `(dev) would update to ${artifactRef}`);
        return;
    }
    // Check out the target commit and install all deps. `npm ci` (not --omit=dev) is required
    // because the daemon runs via tsx, a devDependency, and `git checkout --force` discards any
    // in-place edits so a node can always converge on the target commit.
    updateLog.info({ action: 'apply_version_started', artifactRef, nsmRepoDir: config.nsmRepoDir }, `applying version ${artifactRef} locally`);
    const cmd = `cd ${config.nsmRepoDir} && git fetch --all --tags --prune && git checkout --force ${artifactRef} && npm ci`;
    const { out, code } = await execSafe(cmd, 1000 * 60 * 5);
    if (code !== 0) {
        updateLog.error({ action: 'apply_version_failed', artifactRef, exitCode: code, out }, `failed to update to ${artifactRef}`);
        return;
    }
    // The leader serves the management UI, so rebuild it from the new code before restarting. The
    // VITE_* build inputs are already in the daemon's environment via the systemd EnvironmentFile.
    if (cluster.isLeader()) {
        updateLog.info({ action: 'ui_rebuild_started', wwwPath: config.wwwPath }, 'rebuilding management UI');
        const build = `cd ${config.nsmRepoDir} && NSM_UI_OUT=${config.wwwPath} npm run build -w frontend`;
        const { out: buildOut, code: buildCode } = await execSafe(build, 1000 * 60 * 5);
        if (buildCode !== 0) updateLog.error({ action: 'ui_rebuild_failed', exitCode: buildCode, out: buildOut }, 'UI rebuild failed');
    }
    // Detach so the restart survives this process exiting.
    updateLog.info({ action: 'systemd_restart', artifactRef }, 'restarting nsmd via systemd');
    void execSafe(sudo('systemctl restart nsmd'), 5000);
};

// === Leader-orchestrated rolling upgrade ===
// One node at a time; followers first, leader last.
let rolloutInProgress = false;

export const runSelfUpdateRolloutIfLeader = async (): Promise<void> => {
    if (!cluster.isLeader() || rolloutInProgress) {
        updateLog.debug({ action: 'rollout_skipped', rolloutInProgress }, 'rollout tick skipped');
        return;
    }
    const desired = await getDesiredNsmVersion();
    if (!desired) {
        updateLog.debug({ action: 'rollout_no_desired' }, 'no desired version set');
        return;
    }

    const reports = getNodeHealthReports();
    const members = await getAllNodesModel();
    const selfId = config.nodeId;

    // Followers needing upgrade (exclude self; leader goes last).
    const staleFollowers = members.filter((m) => m.nodeId !== selfId).filter((m) => (reports[m.nodeId]?.nsmVersion || 'unknown') !== desired.version);

    if (staleFollowers.length === 0) {
        // All followers are up to date; if leader itself is stale, upgrade last.
        if ((config.commit || config.version) !== desired.version) {
            rolloutInProgress = true;
            updateLog.info({ action: 'rollout_leader_upgrade', version: desired.version, artifactRef: desired.artifactRef, currentVersion: config.commit || config.version }, 'leader is last to upgrade; applying now');
            await applyVersionLocally(desired.artifactRef);
        }
        return;
    }

    rolloutInProgress = true;
    try {
        const target = staleFollowers[0];
        updateLog.info({ action: 'rollout_instruct_follower', targetNodeId: target.nodeId, targetAddress: target.address, version: desired.version, artifactRef: desired.artifactRef }, `instructing ${target.nodeId} to upgrade to ${desired.version}`);
        const node = members.find((m) => m.nodeId === target.nodeId)!;
        // Ask the node to upgrade itself (see /cluster/apply-update route).
        const { postToNode } = await import('./leaderClient');
        const res = await postToNode(node.address, node.apiPort, '/cluster/apply-update', { version: desired.version, artifactRef: desired.artifactRef });
        if (!res) updateLog.warn({ action: 'rollout_instruct_failed', targetNodeId: target.nodeId, version: desired.version }, `failed to instruct ${target.nodeId} to upgrade`);
    } finally {
        // Allow the next tick to continue once the node has come back healthy.
        setTimeout(() => (rolloutInProgress = false), 60000);
    }
};

// Node receives the instruction to upgrade itself.
export const applyUpdateInstruction = async (artifactRef: string): Promise<void> => {
    updateLog.info({ action: 'update_instruction_received', artifactRef, nodeId: config.nodeId }, `received update instruction for ${artifactRef}`);
    await applyVersionLocally(artifactRef);
};
