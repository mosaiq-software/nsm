import { Badge, Loader, MantineSize } from '@mantine/core';
import { DeploymentState } from '@mosaiq/nsm-common/types';

const STATE_COLOR: Record<DeploymentState, string> = {
    [DeploymentState.READY]: 'gray',
    [DeploymentState.QUEUED]: 'grape',
    [DeploymentState.DEPLOYING]: 'blue',
    [DeploymentState.FAILED]: 'red',
    [DeploymentState.DEPLOYED]: 'teal',
    [DeploymentState.HEALTHY]: 'green',
    [DeploymentState.DESTROYING]: 'orange',
    [DeploymentState.CANCELLED]: 'gray',
};

const IN_PROGRESS_STATES: DeploymentState[] = [DeploymentState.QUEUED, DeploymentState.DEPLOYING, DeploymentState.DESTROYING];

export const isInProgressState = (state: DeploymentState): boolean => IN_PROGRESS_STATES.includes(state);

export const DeploymentStateBadge = ({ state, size }: { state: DeploymentState; size?: MantineSize }) => {
    const color = STATE_COLOR[state] ?? 'gray';
    const inProgress = isInProgressState(state);
    return (
        <Badge color={color} size={size} variant="light" leftSection={inProgress ? <Loader size={10} color={color} /> : undefined}>
            {state}
        </Badge>
    );
};
