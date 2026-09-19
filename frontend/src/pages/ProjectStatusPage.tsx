import { Badge, Box, Card, Center, Group, Loader, SegmentedControl, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { HealthCheckType, HealthStatus, Project, ProjectHealthCheck, ProjectHealthSummary, UptimeBucket, UptimeWindowKey } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useAPI } from '@/utils/api';
import { ProjectHeader } from '@/components/ProjectHeader';
import { IncidentSection } from '@/components/IncidentSection';

const WINDOWS: { value: UptimeWindowKey; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '90d', label: '90d' },
];

// Mantine color name for each health status, used for badges and heatmap cells.
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

// Render a ratio as an uptime percentage with enough precision to distinguish "nines".
const formatUptime = (ratio: number): string => `${(ratio * 100).toFixed(3)}%`;

const CheckRow = ({ check }: { check: ProjectHealthCheck }) => {
    const kind = check.checkType === HealthCheckType.URL ? 'URL' : 'Container';
    return (
        <Group justify="space-between" wrap="nowrap" gap="sm">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge size="xs" variant="light" color="gray">
                    {kind}
                </Badge>
                <Text size="sm" truncate="end" title={check.target}>
                    {check.target}
                </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
                {check.latencyMs !== undefined && (
                    <Text size="xs" c="dimmed">
                        {check.latencyMs} ms
                    </Text>
                )}
                <Tooltip label={check.detail ?? statusLabel(check.status)} disabled={!check.detail}>
                    <Badge color={statusColor(check.status)} variant="light">
                        {statusLabel(check.status)}
                    </Badge>
                </Tooltip>
            </Group>
        </Group>
    );
};

const HeatmapCell = ({ bucket }: { bucket: UptimeBucket }) => {
    const label =
        bucket.sampleCount === 0
            ? `${new Date(bucket.start).toLocaleString()} — no data`
            : `${new Date(bucket.start).toLocaleString()} — ${formatUptime(bucket.upRatio)} up (${bucket.sampleCount} samples)`;
    return (
        <Tooltip label={label} withArrow>
            <Box
                style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    backgroundColor: `var(--mantine-color-${statusColor(bucket.status)}-6)`,
                    opacity: bucket.sampleCount === 0 ? 0.35 : 1,
                }}
            />
        </Tooltip>
    );
};

const ProjectStatusPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const api = useAPI();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [window, setWindow] = useState<UptimeWindowKey>('90d');
    const [summary, setSummary] = useState<ProjectHealthSummary | null>(null);

    useEffect(() => {
        setProject(projectCtx.projects.find((proj) => proj.id === projectId));
    }, [projectId, projectCtx.projects]);

    useEffect(() => {
        if (!projectId || !api.token) return;
        let cancelled = false;
        const load = () => {
            api.get(API_ROUTES.GET_PROJECT_HEALTH, { projectId }, { window }).then((res) => {
                if (!cancelled && res) setSummary(res);
            });
        };
        load();
        const interval = setInterval(load, 30000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [projectId, api.token, window]);

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

            <Card withBorder>
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
                    <Group gap={3} wrap="wrap">
                        {summary.buckets.map((b) => (
                            <HeatmapCell key={b.start} bucket={b} />
                        ))}
                    </Group>
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

            <IncidentSection projectId={project.id} />
        </Stack>
    );
};

export default ProjectStatusPage;
