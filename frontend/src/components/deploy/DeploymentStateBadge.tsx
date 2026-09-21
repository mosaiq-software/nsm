import { Badge, Loader, MantineSize } from '@mantine/core';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { stateInfo } from '@/utils/projectStatus';

export const DeploymentStateBadge = ({ state, size }: { state: DeploymentState; size?: MantineSize }) => {
    const { color, inProgress } = stateInfo(state);
    return (
        <Badge color={color} size={size} variant="light" leftSection={inProgress ? <Loader size={10} color={color} /> : undefined}>
            {state}
        </Badge>
    );
};
