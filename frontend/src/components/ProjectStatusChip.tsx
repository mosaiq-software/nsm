import { Badge, Loader, MantineSize } from '@mantine/core';
import { useCluster } from '@/hooks/queries/useCluster';
import { useProjects, useProjectStatuses } from '@/hooks/queries/useProjects';
import { deployQueueStatusFor } from '@/utils/deployQueue';
import { deriveProjectState, projectStatusInfo } from '@/utils/projectStatus';

export const ProjectStatusChip = ({ projectId, size = 'xs' }: { projectId: string; size?: MantineSize }) => {
    const { projects } = useProjects();
    const statusById = useProjectStatuses();
    const clusterCtx = useCluster();

    const state = statusById[projectId] ?? (() => {
        const project = projects.find((p) => p.id === projectId);
        return project ? deriveProjectState(project) : undefined;
    })();

    const queueStatus = deployQueueStatusFor(clusterCtx.status, projectId);
    const { label, color, inProgress } = projectStatusInfo(state, queueStatus);

    return (
        <Badge color={color} size={size} variant="light" leftSection={inProgress ? <Loader size={8} color={color} /> : undefined}>
            {label}
        </Badge>
    );
};
