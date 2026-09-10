import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { getDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { cluster } from './node';
import { getNodeHealthReports } from './statusGossip';

// === CI webhook entry (leader) ===
export const setDesiredNsmVersion = async (version: string, artifactRef: string): Promise<void> => {
    await cluster.propose({ type: OpType.SET_DESIRED_NSM_VERSION, version, artifactRef });
};

// === Node side: apply the new version to THIS host, then restart via systemd ===
// systemd Restart=always brings nsmd back on the new code. Leader coordinates ordering.
const applyVersionLocally = async (artifactRef: string): Promise<void> => {
    if (!config.production) {
        console.log(`[selfupdate] (dev) would update to ${artifactRef}`);
        return;
    }
    // Pull the new code (git-tag based by default) and restart the service.
    const cmd = `cd ${config.nsmRepoDir} && git fetch --all --tags && git checkout ${artifactRef} && npm ci --omit=dev`;
    const { out, code } = await execSafe(cmd, 1000 * 60 * 5);
    if (code !== 0) {
        console.error(`[selfupdate] failed to fetch ${artifactRef}: ${out}`);
        return;
    }
    // Detach so the restart survives this process exiting.
    void execSafe('systemctl restart nsmd', 5000);
};

// === Leader-orchestrated rolling upgrade ===
// One node at a time; followers first, leader last (after transferring away the VIP/leadership).
let rolloutInProgress = false;

export const runSelfUpdateRolloutIfLeader = async (): Promise<void> => {
    if (!cluster.isLeader() || rolloutInProgress) return;
    const desired = await getDesiredNsmVersion();
    if (!desired) return;

    const reports = getNodeHealthReports();
    const members = cluster.members();
    const selfId = config.nodeId;

    // Followers needing upgrade (exclude self; leader goes last).
    const staleFollowers = members.filter((m) => m.nodeId !== selfId).filter((m) => (reports[m.nodeId]?.nsmVersion || 'unknown') !== desired.version);

    if (staleFollowers.length === 0) {
        // All followers are up to date; if leader itself is stale, upgrade last.
        if (config.version !== desired.version) {
            rolloutInProgress = true;
            console.log('[selfupdate] leader is last to upgrade; applying now');
            await applyVersionLocally(desired.artifactRef);
        }
        return;
    }

    rolloutInProgress = true;
    try {
        const target = staleFollowers[0];
        console.log(`[selfupdate] instructing ${target.nodeId} to upgrade to ${desired.version}`);
        const node = members.find((m) => m.nodeId === target.nodeId)!;
        // Ask the node to upgrade itself (see /cluster/apply-update route).
        const { postToNode } = await import('./leaderClient');
        await postToNode(node.address, node.apiPort, '/cluster/apply-update', { version: desired.version, artifactRef: desired.artifactRef });
    } finally {
        // Allow the next tick to continue once the node has come back healthy.
        setTimeout(() => (rolloutInProgress = false), 60000);
    }
};

// Node receives the instruction to upgrade itself.
export const applyUpdateInstruction = async (artifactRef: string): Promise<void> => {
    await applyVersionLocally(artifactRef);
};
