import { DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { DeployQueueStatus } from './deployQueue';

export interface ProjectStatusInfo {
    label: string;
    color: string;
    inProgress: boolean;
}

// The project-level `state` is only ever `READY` server-side; the real status lives on its
// deployment instances. Prefer the active (serving) instance, then the newest instance, then the
// project's own state.
export const deriveProjectState = (project: Project): DeploymentState => {
    const instances = project.instances ?? [];
    const active = instances.find((i) => i.active);
    if (active) return active.state;
    const newest = instances[0];
    if (newest) return newest.state;
    return project.state ?? DeploymentState.READY;
};

const DEFAULT_STATUS: ProjectStatusInfo = { label: 'Undeployed', color: 'gray', inProgress: false };

// Single source of truth for how each deployment state is presented: label, chip color, and whether
// it represents in-flight work. Both the project status chip (projectStatusInfo) and the per-instance
// badge (DeploymentStateBadge) read from this via stateInfo(), so a state is styled in exactly one
// place.
const STATE_INFO: Record<DeploymentState, ProjectStatusInfo> = {
    [DeploymentState.READY]: DEFAULT_STATUS,
    [DeploymentState.QUEUED]: { label: 'Queued', color: 'grape', inProgress: true },
    [DeploymentState.DEPLOYING]: { label: 'Deploying', color: 'blue', inProgress: true },
    [DeploymentState.FAILED]: { label: 'Failed', color: 'red', inProgress: false },
    [DeploymentState.DEPLOYED]: { label: 'Deployed', color: 'teal', inProgress: false },
    [DeploymentState.HEALTHY]: { label: 'Healthy', color: 'green', inProgress: false },
    [DeploymentState.DESTROYING]: { label: 'Tearing down', color: 'orange', inProgress: true },
    [DeploymentState.DESTROYED]: { label: 'Torn down', color: 'gray', inProgress: false },
    [DeploymentState.CANCELLED]: { label: 'Cancelled', color: 'gray', inProgress: false },
};

// Presentation info for a single deployment state, falling back to "Undeployed" for an unknown state.
export const stateInfo = (state: DeploymentState | undefined): ProjectStatusInfo => STATE_INFO[state ?? DeploymentState.READY] ?? DEFAULT_STATUS;

// Whether a state represents in-flight work (drives the badge spinner and live-tailing consumers).
export const isInProgressState = (state: DeploymentState): boolean => stateInfo(state).inProgress;

// Combine the derived deployment state with the live deploy queue: an in-flight deploy always wins
// so the chip reflects real-time progress before instance state catches up.
export const projectStatusInfo = (state: DeploymentState | undefined, queueStatus: DeployQueueStatus): ProjectStatusInfo => {
    if (queueStatus.state === 'active') return { label: 'Deploying', color: 'blue', inProgress: true };
    if (queueStatus.state === 'queued') return { label: `Queued #${queueStatus.position}`, color: 'grape', inProgress: true };
    return stateInfo(state);
};
