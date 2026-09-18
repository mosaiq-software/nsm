import { Card, Group, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { MdOutlineBolt } from 'react-icons/md';
import { DeploymentStateBadge } from './DeploymentStateBadge';

interface DeploymentInstanceListProps {
    instances: ProjectInstanceHeader[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}

export const DeploymentInstanceList = ({ instances, selectedId, onSelect }: DeploymentInstanceListProps) => {
    if (instances.length === 0) {
        return (
            <Card withBorder w={300} miw={300}>
                <Text c="dimmed" fz="sm" ta="center" py="md">
                    No deployments yet.
                </Text>
            </Card>
        );
    }

    return (
        <Card withBorder w={300} miw={300} p={4}>
            <ScrollArea.Autosize mah={640} type="auto">
                <Stack gap={4}>
                    {instances.map((instance) => {
                        const selected = instance.id === selectedId;
                        return (
                            <UnstyledButton
                                key={instance.id}
                                onClick={() => onSelect(instance.id)}
                                p="xs"
                                style={{
                                    borderRadius: 'var(--mantine-radius-sm)',
                                    background: selected ? 'var(--mantine-color-blue-light)' : undefined,
                                }}
                            >
                                <Group justify="space-between" wrap="nowrap" gap="xs">
                                    <Stack gap={2} style={{ minWidth: 0 }}>
                                        <Text fz="sm" fw={selected ? 600 : 400} truncate>
                                            {new Date(instance.created).toLocaleString()}
                                        </Text>
                                        <Text fz="xs" c="dimmed" truncate>
                                            {instance.id.split('-')[0]}
                                        </Text>
                                    </Stack>
                                    <Group gap={4} wrap="nowrap">
                                        {instance.active && (
                                            <Tooltip label="Active deployment" withArrow>
                                                <Text c="yellow" component="span" style={{ display: 'flex' }}>
                                                    <MdOutlineBolt size={16} />
                                                </Text>
                                            </Tooltip>
                                        )}
                                        <DeploymentStateBadge state={instance.state} size="sm" />
                                    </Group>
                                </Group>
                            </UnstyledButton>
                        );
                    })}
                </Stack>
            </ScrollArea.Autosize>
        </Card>
    );
};
