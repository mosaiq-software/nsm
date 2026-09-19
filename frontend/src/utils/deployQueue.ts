import { ClusterStatus, DeployQueueEntry } from '@mosaiq/nsm-common/types';

export type DeployQueueStatus = { state: 'active' | 'queued' | null; position: number };

// Where a project sits in the leader's deploy queue: actively deploying, waiting (1-based position),
// or not in the queue at all.
export const deployQueueStatusFor = (status: ClusterStatus | null | undefined, projectId: string): DeployQueueStatus => {
    const queue = status?.deployQueue;
    if (!queue) return { state: null, position: 0 };
    // `deploying` reflects the full build (not just the brief leader planning slot in `active`).
    if (queue.deploying?.some((e) => e.projectId === projectId)) return { state: 'active', position: 0 };
    if (queue.active?.projectId === projectId) return { state: 'active', position: 0 };
    const idx = queue.queued.findIndex((e) => e.projectId === projectId);
    if (idx >= 0) return { state: 'queued', position: idx + 1 };
    return { state: null, position: 0 };
};

export interface DeployQueueSummary {
    // In-flight deploys the user can see, with details. Includes the leader planning slot (`active`)
    // when it isn't already reflected in `deploying`.
    deploying: (DeployQueueEntry & { startedAt: number })[];
    // Waiting deploys the user can see, each with its true 1-based position in the full queue.
    queued: { entry: DeployQueueEntry; position: number }[];
    // How many in-flight / waiting deploys belong to projects the user cannot access (details hidden).
    hiddenDeploying: number;
    hiddenQueued: number;
}

// Split the (already backend-redacted) deploy queue into the user's own detailed entries and counts
// of the entries hidden from them. Redacted entries arrive with `hidden: true` and no identifying
// fields, so we surface only their counts - never their details.
export const summarizeDeployQueue = (status: ClusterStatus | null | undefined): DeployQueueSummary => {
    const queue = status?.deployQueue;
    if (!queue) return { deploying: [], queued: [], hiddenDeploying: 0, hiddenQueued: 0 };

    const visibleDeploying = queue.deploying.filter((e) => !e.hidden);
    const active = queue.active;
    const includeActive = !!active && !active.hidden && !visibleDeploying.some((d) => d.projectId === active.projectId);
    const deploying = [...(includeActive ? [active] : []), ...visibleDeploying];
    // Hidden in-flight deploys are counted from `deploying` (the authoritative set of live builds);
    // the transient planning slot isn't separately counted to avoid double-counting a hidden project.
    const hiddenDeploying = queue.deploying.filter((e) => e.hidden).length;

    const queued = queue.queued.map((entry, idx) => ({ entry, position: idx + 1 })).filter((q) => !q.entry.hidden);
    const hiddenQueued = queue.queued.filter((e) => e.hidden).length;

    return { deploying, queued, hiddenDeploying, hiddenQueued };
};
