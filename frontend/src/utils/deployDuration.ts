import { DeploymentState, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { isInProgressState } from '@/components/deploy/DeploymentStateBadge';

// How long a deployment took, or - for one still in flight - how long it has been running so far
// (pass `now` from a ticking clock so live values count up). Returns undefined when there is nothing
// meaningful to show yet (e.g. a READY instance that has never deployed).
export const deploymentDurationMs = (header: ProjectInstanceHeader, now: number): number | undefined => {
    const start = header.deployStartedAt ?? header.created;
    if (isInProgressState(header.state)) return Math.max(0, now - start);
    if (header.state === DeploymentState.DEPLOYED || header.state === DeploymentState.HEALTHY) {
        return header.deployDurationMs ?? Math.max(0, header.lastUpdated - start);
    }
    if (header.state === DeploymentState.FAILED || header.state === DeploymentState.CANCELLED) {
        return Math.max(0, header.lastUpdated - start);
    }
    return undefined;
};

// Precise human-readable duration: "45s", "2m 15s", "1h 5m". Unlike formatDeployEta (deployQueue.ts)
// this is exact (no "~" prefix), for showing real elapsed/build times rather than rough estimates.
export const formatDuration = (ms: number | undefined | null): string | null => {
    if (ms == null || !isFinite(ms) || ms < 0) return null;
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
};
