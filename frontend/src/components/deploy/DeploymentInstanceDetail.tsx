import { ActionIcon, Button, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { Link } from 'react-router-dom';
import { MdOutlineBolt, MdOutlineRefresh, MdOutlineViewList } from 'react-icons/md';
import { useLiveProjectInstance } from '@/hooks/useLiveProjectInstance';
import { useNow } from '@/hooks/useNow';
import { deploymentDurationMs, formatDuration } from '@/utils/deployDuration';
import { BuildLogConsole } from './BuildLogConsole';
import { DeploymentStateBadge } from './DeploymentStateBadge';
import { isInProgressState } from '@/utils/projectStatus';
import { ServiceStatusCard } from './ServiceStatusCard';

const SummaryField = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <Stack gap={0}>
        <Text fz="xs" c="dimmed">
            {label}
        </Text>
        <Text fz="sm">{children}</Text>
    </Stack>
);

export const DeploymentInstanceDetail = ({ header }: { header: ProjectInstanceHeader }) => {
    const { instance, loading, refresh } = useLiveProjectInstance(header.id);

    const state = instance?.state ?? header.state;
    const created = instance?.created ?? header.created;
    const lastUpdated = instance?.lastUpdated ?? header.lastUpdated;
    const workerNodeId = instance?.workerNodeId ?? header.workerNodeId;
    const active = instance?.active ?? header.active;
    const services = instance?.services ?? [];

    const inProgress = isInProgressState(state);
    const now = useNow(inProgress);
    const duration = formatDuration(deploymentDurationMs({ ...header, ...instance, state, created, lastUpdated }, now));

    return (
        <Stack style={{ flex: 1, minWidth: 0 }}>
            <Card withBorder>
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="sm" wrap="nowrap">
                        <DeploymentStateBadge state={state} />
                        {active && (
                            <Group gap={4} c="yellow">
                                <MdOutlineBolt size={16} />
                                <Text fz="sm" fw={600}>
                                    Active
                                </Text>
                            </Group>
                        )}
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                        <Button
                            component={Link}
                            to={`/p/${header.projectId}/monitoring/logs?instance=${header.id}`}
                            variant="light"
                            size="compact-sm"
                            leftSection={<MdOutlineViewList />}
                        >
                            View logs
                        </Button>
                        <Tooltip label="Refresh">
                            <ActionIcon variant="light" onClick={() => void refresh()} loading={loading}>
                                <MdOutlineRefresh />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                </Group>
                <SimpleGrid cols={{ base: 2, sm: 5 }} mt="md">
                    <SummaryField label="Created">{new Date(created).toLocaleString()}</SummaryField>
                    <SummaryField label="Last updated">{new Date(lastUpdated).toLocaleString()}</SummaryField>
                    <SummaryField label={inProgress ? 'Elapsed' : 'Duration'}>{duration ?? '—'}</SummaryField>
                    <SummaryField label="Node">{workerNodeId || 'Unassigned'}</SummaryField>
                    <SummaryField label="Instance">{header.id.split('-')[0]}</SummaryField>
                </SimpleGrid>
            </Card>

            <BuildLogConsole log={instance?.deploymentLog} live={isInProgressState(state)} />

            <Stack gap="xs">
                <Title order={6}>Services</Title>
                {services.length === 0 ? (
                    <Text c="dimmed" fz="sm">
                        No services for this deployment.
                    </Text>
                ) : (
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        {services.map((service) => (
                            <ServiceStatusCard key={service.instanceId} service={service} />
                        ))}
                    </SimpleGrid>
                )}
            </Stack>
        </Stack>
    );
};
