import { ActionIcon, Alert, Anchor, Card, Center, Group, Loader, SegmentedControl, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { LogSelector, Project } from '@mosaiq/nsm-common/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProjects } from '@/hooks/queries/useProjects';
import { useMe } from '@/hooks/queries/useMe';
import { useProjectInstance, useObservabilityMetrics, useProjectResourceUsage } from '@/hooks/queries/projectHooks';
import { ResourceUsageBars } from '@/components/ResourceAllocation';
import { formatAxisTime, formatBytes, formatBytesPerSec, formatCores } from '@/utils/format';
import { ProjectHeader } from '@/components/ProjectHeader';
import { MdOutlineRefresh } from 'react-icons/md';

type MetricKind = 'cpu' | 'mem' | 'net' | 'storage';

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
            return 'Memory';
        case 'net':
            return 'Network';
        case 'storage':
            return 'Storage';
    }
};

const metricSeriesLabel = (metric: MetricKind) => {
    switch (metric) {
        case 'cpu':
            return 'CPU';
        case 'mem':
            return 'Memory used';
        case 'net':
            return 'Throughput';
        case 'storage':
            return 'Storage used';
    }
};

const metricFormatter = (metric: MetricKind): ((value: number) => string) => {
    switch (metric) {
        case 'cpu':
            return formatCores;
        case 'mem':
            return formatBytes;
        case 'net':
            return formatBytesPerSec;
        case 'storage':
            return formatBytes;
    }
};

const MonitoringMetricsPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const { projects } = useProjects();
    const meCtx = useMe();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [scope, setScope] = useState<string>(PROJECT_SCOPE);
    const [rangeMs, setRangeMs] = useState<number>(TIME_RANGES[1].ms);
    const [metric, setMetric] = useState<MetricKind>('cpu');

    useEffect(() => {
        const foundProject = projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
    }, [projectId, projects]);

    // Fetch the selected instance (only when the scope points at a concrete project instance) so its
    // services can be listed in the scope picker.
    const scopedInstanceId = project?.instances?.find((i) => i.id === scope)?.id;
    const { data: instance } = useProjectInstance(scopedInstanceId);

    const selector = useMemo((): LogSelector => {
        if (metric === 'storage') return { projectId: projectId };
        if (scope === PROJECT_SCOPE) return { projectId: projectId };
        if (scope.startsWith('service:')) return { serviceInstanceId: scope.slice('service:'.length) };
        return { projectInstanceId: scope };
    }, [scope, projectId, metric]);

    const metricsQuery = useObservabilityMetrics(selector, metric, rangeMs, !!project);
    const metrics = metricsQuery.data ?? null;
    const loading = metricsQuery.isFetching;
    const refresh = () => void metricsQuery.refetch();

    const { data: resourceUsage } = useProjectResourceUsage(projectId);

    const chartData = useMemo(() => {
        const series = metrics?.series ?? [];
        if (series.length === 0) return [] as Record<string, number | string>[];
        const byTime = new Map<number, number>();
        for (const s of series) {
            for (const point of s.values) byTime.set(point.t, (byTime.get(point.t) ?? 0) + point.v);
        }
        return Array.from(byTime.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([t, value]) => ({ time: formatAxisTime(t, rangeMs), value }));
    }, [metrics, rangeMs]);

    const chartSeries = useMemo(() => [{ name: 'value', label: metricSeriesLabel(metric), color: 'blue.6' }], [metric]);

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
            <ProjectHeader project={project} section="Metrics" />
            <Group align="flex-end" justify="space-between">
                <Group align="flex-end">
                    <Select label="Scope" data={scopeOptions} value={scope} onChange={(v) => setScope(v || PROJECT_SCOPE)} w={320} disabled={metric === 'storage'} />
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
                        onChange={(v) => {
                            const next = v as MetricKind;
                            if (next === 'storage') setScope(PROJECT_SCOPE);
                            setMetric(next);
                        }}
                        data={[
                            { value: 'cpu', label: 'CPU' },
                            { value: 'mem', label: 'Memory' },
                            { value: 'net', label: 'Network' },
                            { value: 'storage', label: 'Storage' },
                        ]}
                    />
                </Group>
                {chartData.length === 0 ? (
                    <Center py="xl">
                        <Text c="dimmed">No metric data for this selection.</Text>
                    </Center>
                ) : (
                    <LineChart
                        h={280}
                        data={chartData}
                        dataKey="time"
                        series={chartSeries}
                        curveType="monotone"
                        withDots={false}
                        strokeWidth={2}
                        tickLine="y"
                        gridAxis="y"
                        yAxisLabel={metricLabel(metric)}
                        yAxisProps={{ width: 72 }}
                        xAxisProps={{ minTickGap: 40 }}
                        valueFormatter={metricFormatter(metric)}
                    />
                )}
            </Card>

            <Card withBorder>
                <Group justify="space-between" align="center" mb="sm">
                    <Title order={5}>Resource Allocation</Title>
                    {meCtx.isAdmin && (
                        <Anchor component={Link} to={`/p/${project.id}/config/resources`} fz="sm">
                            Edit allocation
                        </Anchor>
                    )}
                </Group>
                <ResourceUsageBars quota={project.resourceQuota} usage={resourceUsage ?? undefined} />
            </Card>
        </Stack>
    );
};

export default MonitoringMetricsPage;
