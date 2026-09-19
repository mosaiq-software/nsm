import { Badge, Box, Card, Center, Group, Loader, SegmentedControl, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { HealthCheckType, HealthStatus, Project, ProjectHealthCheck, UptimeBucket, UptimeWindowKey } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProjects } from '@/hooks/queries/useProjects';
import { useProjectHealth } from '@/hooks/queries/projectHooks';
import { ProjectHeader } from '@/components/ProjectHeader';

const WINDOWS: { value: UptimeWindowKey; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '90d', label: '90d' },
];

const statusColor = (status: HealthStatus): string => {
    switch (status) {
        case HealthStatus.UP:
            return 'green';
        case HealthStatus.DEGRADED:
            return 'yellow';
        case HealthStatus.DOWN:
            return 'red';
        default:
            return 'gray';
    }
};

const statusLabel = (status: HealthStatus): string => {
    switch (status) {
        case HealthStatus.UP:
            return 'Operational';
        case HealthStatus.DEGRADED:
            return 'Degraded';
        case HealthStatus.DOWN:
            return 'Down';
        default:
            return 'Unknown';
    }
};

const formatUptime = (ratio: number): string => `${(ratio * 100).toFixed(3)}%`;

const CheckRow = ({ check }: { check: ProjectHealthCheck }) => {
    const kind = check.checkType === HealthCheckType.URL ? 'URL' : 'Container';
    return (
        <Group wrap="nowrap" gap="sm" align="center">
            <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                <Badge size="xs" variant="light" color="gray">
                    {kind}
                </Badge>
                <Text size="sm" truncate="end" title={check.target}>
                    {check.target}
                </Text>
            </Group>
            <Text size="xs" c="dimmed" ta="right" w={70} style={{ flexShrink: 0 }}>
                {check.latencyMs !== undefined ? `${check.latencyMs} ms` : ''}
            </Text>
            <Box w={110} style={{ flexShrink: 0 }}>
                <Tooltip label={check.detail ?? statusLabel(check.status)} disabled={!check.detail}>
                    <Badge color={statusColor(check.status)} variant="light" fullWidth>
                        {statusLabel(check.status)}
                    </Badge>
                </Tooltip>
            </Box>
        </Group>
    );
};

const HeatmapBar = ({ bucket }: { bucket: UptimeBucket }) => {
    const label =
        bucket.sampleCount === 0
            ? `${new Date(bucket.start).toLocaleString()} — no data`
            : `${new Date(bucket.start).toLocaleString()} — ${formatUptime(bucket.upRatio)} up (${bucket.sampleCount} samples)`;
    return (
        <Tooltip label={label} withArrow>
            <Box
                style={{
                    flex: 1,
                    minWidth: 0,
                    height: 40,
                    borderRadius: 2,
                    backgroundColor: `var(--mantine-color-${statusColor(bucket.status)}-6)`,
                    opacity: bucket.sampleCount === 0 ? 0.35 : 1,
                }}
            />
        </Tooltip>
    );
};

const MonitoringStatusPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const { projects } = useProjects();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [window, setWindow] = useState<UptimeWindowKey>('90d');
    const { data: summary } = useProjectHealth(projectId, window);

    useEffect(() => {
        setProject(projects.find((proj) => proj.id === projectId));
    }, [projectId, projects]);

    if (project === undefined) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }

    if (!project || !project.id) {
        return (
            <Center>
                <Stack>
                    <Title order={4}>Project &quot;{projectId}&quot; not found!</Title>
                </Stack>
            </Center>
        );
    }

    const overall = summary?.overall ?? HealthStatus.UNKNOWN;

    return (
        <Stack>
            <ProjectHeader project={project} section="Status" />

            <Card withBorder maw={640}>
                <Group justify="space-between" align="center">
                    <Title order={4}>Current status</Title>
                    <Badge size="lg" color={statusColor(overall)} variant="filled">
                        {statusLabel(overall)}
                    </Badge>
                </Group>
                <Stack gap="xs" mt="md">
                    {!summary || summary.checks.length === 0 ? (
                        <Text c="dimmed" size="sm">
                            No health checks yet. NSM probes each public URL and container once it has been deployed.
                        </Text>
                    ) : (
                        summary.checks.map((check) => <CheckRow key={`${check.checkType}:${check.target}`} check={check} />)
                    )}
                </Stack>
            </Card>

            <Card withBorder>
                <Group justify="space-between" align="center" mb="sm">
                    <Title order={4}>Uptime</Title>
                    <SegmentedControl value={window} onChange={(v) => setWindow(v as UptimeWindowKey)} data={WINDOWS} />
                </Group>
                <SimpleGrid cols={{ base: 2, sm: 4 }} mb="md">
                    {(summary?.windows ?? []).map((w) => (
                        <Card key={w.window} withBorder padding="sm">
                            <Text size="xs" c="dimmed" tt="uppercase">
                                {w.window}
                            </Text>
                            <Text fw={700} size="lg">
                                {w.sampleCount === 0 ? '—' : formatUptime(w.uptimeRatio)}
                            </Text>
                            <Text size="xs" c="dimmed">
                                {w.sampleCount} samples
                            </Text>
                        </Card>
                    ))}
                </SimpleGrid>
                <Text size="sm" fw={500} mb={6}>
                    History ({window})
                </Text>
                {!summary || summary.buckets.length === 0 ? (
                    <Text c="dimmed" size="sm">
                        No history yet.
                    </Text>
                ) : (
                    <Box style={{ display: 'flex', width: '100%', gap: 2, alignItems: 'stretch' }}>
                        {summary.buckets.map((b) => (
                            <HeatmapBar key={b.start} bucket={b} />
                        ))}
                    </Box>
                )}
                <Group gap="lg" mt="md">
                    {[HealthStatus.UP, HealthStatus.DEGRADED, HealthStatus.DOWN, HealthStatus.UNKNOWN].map((s) => (
                        <Group gap={6} key={s}>
                            <Box style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: `var(--mantine-color-${statusColor(s)}-6)` }} />
                            <Text size="xs" c="dimmed">
                                {statusLabel(s)}
                            </Text>
                        </Group>
                    ))}
                </Group>
            </Card>
        </Stack>
    );
};

export default MonitoringStatusPage;
