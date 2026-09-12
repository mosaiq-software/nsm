import { ClusterStatus } from '@mosaiq/nsm-common/types';

export type DeployQueueStatus = { state: 'active' | 'queued' | null; position: number };

// Where a project sits in the leader's deploy queue: actively deploying, waiting (1-based position),
// or not in the queue at all.
export const deployQueueStatusFor = (status: ClusterStatus | null | undefined, projectId: string): DeployQueueStatus => {
    const queue = status?.deployQueue;
    if (!queue) return { state: null, position: 0 };
    if (queue.active?.projectId === projectId) return { state: 'active', position: 0 };
    const idx = queue.queued.findIndex((e) => e.projectId === projectId);
    if (idx >= 0) return { state: 'queued', position: idx + 1 };
    return { state: null, position: 0 };
};
