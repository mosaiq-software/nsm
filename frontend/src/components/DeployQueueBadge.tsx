import { Badge, MantineSize } from '@mantine/core';
import { useCluster } from '@/contexts/cluster-context';
import { deployQueueStatusFor } from '@/utils/deployQueue';

// Renders "Deploying" / "In queue #N" for a project based on the leader's deploy queue, or nothing
// when the project isn't in the queue.
export const DeployQueueBadge = ({ projectId, size }: { projectId: string; size?: MantineSize }) => {
    const clusterCtx = useCluster();
    const { state, position } = deployQueueStatusFor(clusterCtx.status, projectId);
    if (state === 'active')
        return (
            <Badge color="blue" size={size} variant="light">
                Deploying
            </Badge>
        );
    if (state === 'queued')
        return (
            <Badge color="grape" size={size} variant="light">
                In queue #{position}
            </Badge>
        );
    return null;
};
