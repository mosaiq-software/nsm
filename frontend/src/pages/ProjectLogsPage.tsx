import { ActionIcon, Alert, Card, Center, Group, Loader, SegmentedControl, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { LogSelector, ObservabilityMetricsResult, Project, ProjectInstance } from '@mosaiq/nsm-common/types';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useAPI } from '@/utils/api';
import { ProjectHeader } from '@/components/ProjectHeader';
import { LogViewer } from '@/components/LogViewer/LogViewer';
import { MdOutlineRefresh } from 'react-icons/md';

type MetricKind = 'cpu' | 'mem' | 'net';

const TIME_RANGES: { label: string; ms: number }[] = [
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
];

const PROJECT_SCOPE = '__project__';

const metricLabel = (metric: MetricKind) => {
    switch (metric) {
        case 'cpu':
            return 'CPU (cores)';
        case 'mem':
            return 'Memory (bytes)';
        case 'net':
            return 'Network (bytes/s)';
    }
};

const ProjectLogsPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const api = useAPI();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [instance, setInstance] = useState<ProjectInstance | null>(null);
    const [scope, setScope] = useState<string>(PROJECT_SCOPE);
    const [rangeMs, setRangeMs] = useState<number>(TIME_RANGES[1].ms);
    const [metric, setMetric] = useState<MetricKind>('cpu');
    const [metrics, setMetrics] = useState<ObservabilityMetricsResult | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const foundProject = projectCtx.projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
    }, [projectId, projectCtx.projects]);

    // A service-instance scope requires the full instance to resolve its service instance ids.
    useEffect(() => {
        const header = project?.instances?.find((i) => i.id === scope);
        if (!header) {
            setInstance(null);
            return;
        }
        let cancelled = false;
        api.get(API_ROUTES.GET_PROJECT_INSTANCE, { projectInstanceId: header.id }).then((res) => {
            if (!cancelled && res) setInstance(res);
        });
        return () => {
            cancelled = true;
        };
    }, [scope, project]);

    const selector = useMemo((): LogSelector => {
        if (scope === PROJECT_SCOPE) return { projectId: projectId };
        if (scope.startsWith('service:')) return { serviceInstanceId: scope.slice('service:'.length) };
        return { projectInstanceId: scope };
    }, [scope, projectId]);

    const refresh = async () => {
        if (!project) return;
        setLoading(true);
        const now = Date.now();
        const start = now - rangeMs;
        try {
            const metricsRes = await api.get(API_ROUTES.GET_OBSERVABILITY_METRICS, {}, { ...selector, metric, start: `${Math.floor(start / 1000)}`, end: `${Math.floor(now / 1000)}`, step: '30s' });
            setMetrics(metricsRes ?? { metric, series: [] });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!project) return;
        refresh();
        const interval = setInterval(refresh, 15000);
        return () => clearInterval(interval);
    }, [project, scope, rangeMs, metric]);

    const chartData = useMemo(() => {
        const series = metrics?.series ?? [];
        if (series.length === 0) return [] as Record<string, number | string>[];
        const byTime = new Map<number, Record<string, number | string>>();
        series.forEach((s, idx) => {
            const name = Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(',') || `series ${idx + 1}`;
            for (const point of s.values) {
                const existing = byTime.get(point.t) ?? { time: new Date(point.t * 1000).toLocaleTimeString() };
                existing[name] = point.v;
                byTime.set(point.t, existing);
            }
        });
        return Array.from(byTime.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, row]) => row);
    }, [metrics]);

    const chartSeries = useMemo(() => {
        const series = metrics?.series ?? [];
        const palette = ['blue.6', 'teal.6', 'grape.6', 'orange.6', 'red.6', 'cyan.6'];
        return series.map((s, idx) => ({
            name: Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(',') || `series ${idx + 1}`,
            color: palette[idx % palette.length],
        }));
    }, [metrics]);

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

    const scopeOptions: { value: string; label: string }[] = [
        { value: PROJECT_SCOPE, label: 'Entire project' },
        ...(project.instances ?? []).map((i) => ({ value: i.id, label: `Instance ${i.id.split('-')[0]} — ${new Date(i.created).toLocaleString()}` })),
        ...(instance?.services ?? []).map((s) => ({ value: `service:${s.instanceId}`, label: `Service: ${s.serviceName}` })),
    ];

    return (
        <Stack>
            <ProjectHeader project={project} section="Logs & Metrics" />
            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Observability unavailable">
                    Logs and metrics are served by the leader. No leader is currently reachable.
                </Alert>
            )}
            <Group align="flex-end" justify="space-between">
                <Group align="flex-end">
                    <Select label="Scope" data={scopeOptions} value={scope} onChange={(v) => setScope(v || PROJECT_SCOPE)} w={320} />
                    <Stack gap={2}>
                        <Text fz="var(--input-label-size, var(--mantine-font-size-sm))">Metrics range</Text>
                        <SegmentedControl value={String(rangeMs)} onChange={(v) => setRangeMs(Number(v))} data={TIME_RANGES.map((r) => ({ value: String(r.ms), label: r.label }))} />
                    </Stack>
                </Group>
                <Tooltip label="Refresh metrics">
                    <ActionIcon variant="light" size="lg" onClick={refresh} loading={loading}>
                        <MdOutlineRefresh />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <Card withBorder>
                <Group justify="space-between" align="center" mb="sm">
                    <Title order={5}>Metrics</Title>
                    <SegmentedControl
                        value={metric}
                        onChange={(v) => setMetric(v as MetricKind)}
                        data={[
                            { value: 'cpu', label: 'CPU' },
                            { value: 'mem', label: 'Memory' },
                            { value: 'net', label: 'Network' },
                        ]}
                    />
                </Group>
                {chartData.length === 0 ? (
                    <Center py="xl">
                        <Text c="dimmed">No metric data for this selection.</Text>
                    </Center>
                ) : (
                    <LineChart h={280} data={chartData} dataKey="time" series={chartSeries} curveType="monotone" withDots={false} yAxisLabel={metricLabel(metric)} withLegend />
                )}
            </Card>

            <Title order={5}>Logs</Title>
            <LogViewer selector={selector} facetFields={['serviceName', 'nodeId']} defaultColumns={['ts', 'serviceName', 'msg']} />
        </Stack>
    );
};

export default ProjectLogsPage;
