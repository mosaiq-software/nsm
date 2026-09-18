import { Badge, Card, Group, Stack, Text } from '@mantine/core';
import { ProjectServiceInstance } from '@mosaiq/nsm-common/types';
import { MdCircle } from 'react-icons/md';

export const ServiceStatusCard = ({ service }: { service: ProjectServiceInstance }) => {
    const healthy = service.actualContainerState === service.expectedContainerState;
    const color = healthy ? 'green' : 'red';
    return (
        <Card withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" mb={6}>
                <Text fw={600} truncate>
                    {service.serviceName}
                </Text>
                <Badge color={color} variant="light" leftSection={<MdCircle size={8} />}>
                    {healthy ? 'Healthy' : 'Unhealthy'}
                </Badge>
            </Group>
            <Stack gap={2}>
                <Text fz="xs" c="dimmed">
                    Expected: {service.expectedContainerState}
                </Text>
                <Text fz="sm">
                    {service.actualContainerState}
                    <Text span c="dimmed" fz="xs">
                        {' '}
                        as of {new Date(service.lastUpdated).toLocaleString()}
                    </Text>
                </Text>
            </Stack>
        </Card>
    );
};
