import { Badge, MantineSize, Tooltip } from '@mantine/core';
import { useCluster } from '@/contexts/cluster-context';
import { deployQueueStatusFor, formatDeployEta } from '@/utils/deployQueue';

// Renders "Deploying" / "In queue #N" for a project based on the leader's deploy queue, or nothing
// when the project isn't in the queue. Deploy-time estimates (when known) are shown inline for a
// queued item's wait and surfaced as a tooltip with the expected deploy duration.
export const DeployQueueBadge = ({ projectId, size }: { projectId: string; size?: MantineSize }) => {
    const clusterCtx = useCluster();
    const { state, position, estimatedDeployMs, estimatedWaitMs } = deployQueueStatusFor(clusterCtx.status, projectId);
    const deployEta = formatDeployEta(estimatedDeployMs);
    if (state === 'active') {
        const badge = (
            <Badge color="blue" size={size} variant="light">
                Deploying
            </Badge>
        );
        return deployEta ? <Tooltip label={`Typically takes ${deployEta}`}>{badge}</Tooltip> : badge;
    }
    if (state === 'queued') {
        const waitEta = formatDeployEta(estimatedWaitMs);
        const badge = (
            <Badge color="grape" size={size} variant="light">
                In queue #{position}
                {waitEta ? ` \u00b7 starts in ${waitEta}` : ''}
            </Badge>
        );
        return deployEta ? <Tooltip label={`Typically takes ${deployEta} to deploy`}>{badge}</Tooltip> : badge;
    }
    return null;
};
