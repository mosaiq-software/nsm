import { Accordion, ActionIcon, Alert, Anchor, Badge, Button, Card, Center, Group, Loader, Progress, SegmentedControl, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { NodeFilesystemUsage, NodeMetricKind, NodeStorageSpec, ObservabilityMetricsResult, ProjectDiskUsage } from '@mosaiq/nsm-common/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MdArrowBack, MdOutlineCameraAlt, MdOutlineRefresh, MdOutlineStar } from 'react-icons/md';
import { useCluster } from '@/contexts/cluster-context';
import { useAPI } from '@/utils/api';

const TIME_RANGES: { label: string; ms: number }[] = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const METRIC_DEFS: { kind: NodeMetricKind; title: string; yLabel: string; color: string; format: (v: number) => string }[] = [
    { kind: 'cpu', title: 'CPU', yLabel: 'Cores used', color: 'blue.6', format: (v) => `${v.toFixed(2)}` },
    { kind: 'mem', title: 'Memory', yLabel: 'Bytes used', color: 'teal.6', format: (v) => formatBytes(v) },
    { kind: 'net', title: 'Network', yLabel: 'Bytes/s', color: 'grape.6', format: (v) => `${formatBytes(v)}/s` },
    { kind: 'disk', title: 'Disk', yLabel: 'Bytes used', color: 'orange.6', format: (v) => formatBytes(v) },
];

const PROJECT_PALETTE = ['blue.6', 'teal.6', 'grape.6', 'cyan.6', 'lime.6', 'pink.6', 'indigo.6', 'yellow.7', 'red.6', 'green.6'];

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativeTime(ts: number): string {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 0) return 'just now';
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(ts).toLocaleString();
}

// Collapse a (possibly multi-series) node metric result into one { time, value } line by summing
// series per timestamp - node-level expressions return a single series, but this is robust either way.
function singleSeries(result?: ObservabilityMetricsResult): { time: string; value: number }[] {
    const byTime = new Map<number, number>();
    for (const s of result?.series ?? []) {
        for (const p of s.values) byTime.set(p.t, (byTime.get(p.t) ?? 0) + p.v);
    }
    return Array.from(byTime.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ time: new Date(t * 1000).toLocaleTimeString(), value: v }));
}

const fsKey = (device: string, mountpoint: string) => `${device}|${mountpoint}`;
const projectLabel = (p: string) => (p === '__total__' ? 'All projects' : p);

const MetricChart = ({ def, result }: { def: (typeof METRIC_DEFS)[number]; result?: ObservabilityMetricsResult }) => {
    const data = useMemo(() => singleSeries(result), [result]);
    return (
        <Card withBorder>
            <Title order={5} mb="sm">
                {def.title}
            </Title>
            {data.length === 0 ? (
                <Center py="xl">
                    <Text c="dimmed">No data.</Text>
                </Center>
            ) : (
                <LineChart
                    h={200}
                    data={data}
                    dataKey="time"
                    series={[{ name: 'value', label: def.title, color: def.color }]}
                    curveType="monotone"
                    withDots={false}
                    yAxisLabel={def.yLabel}
                    valueFormatter={def.format}
                />
            )}
        </Card>
    );
};

const ProjectBreakdown = ({ project, driveSize }: { project: ProjectDiskUsage; driveSize: number }) => {
    const total = project.totalBytes || project.volumeBytes + project.codeBytes;
    const volPct = total > 0 ? (project.volumeBytes / total) * 100 : 0;
    const codePct = total > 0 ? (project.codeBytes / total) * 100 : 0;
    const driveShare = driveSize > 0 ? ((total / driveSize) * 100).toFixed(1) : '0.0';
    return (
        <Accordion.Item value={`${project.projectId}|${project.device}|${project.mountpoint}`}>
            <Accordion.Control>
                <Group justify="space-between" wrap="nowrap" pr="md">
                    <Text fw={600}>{project.projectId}</Text>
                    <Group gap="xs">
                        <Text size="sm">{formatBytes(total)}</Text>
                        <Badge variant="light" color="gray">
                            {driveShare}% of drive
                        </Badge>
                    </Group>
                </Group>
            </Accordion.Control>
            <Accordion.Panel>
                <Stack gap={6}>
                    <Progress.Root size="xl">
                        <Tooltip label={`Volume: ${formatBytes(project.volumeBytes)}`}>
                            <Progress.Section value={volPct} color="blue.6">
                                <Progress.Label>Volume</Progress.Label>
                            </Progress.Section>
                        </Tooltip>
                        <Tooltip label={`Deployed code: ${formatBytes(project.codeBytes)}`}>
                            <Progress.Section value={codePct} color="orange.6">
                                <Progress.Label>Code</Progress.Label>
                            </Progress.Section>
                        </Tooltip>
                    </Progress.Root>
                    <Group gap="lg">
                        <Group gap={6}>
                            <Badge color="blue.6" variant="filled" size="xs" circle />
                            <Text size="sm">Volume: {formatBytes(project.volumeBytes)}</Text>
                        </Group>
                        <Group gap={6}>
                            <Badge color="orange.6" variant="filled" size="xs" circle />
                            <Text size="sm">Deployed code: {formatBytes(project.codeBytes)}</Text>
                        </Group>
                    </Group>
                </Stack>
            </Accordion.Panel>
        </Accordion.Item>
    );
};

const FilesystemCard = ({ fs, projects }: { fs: NodeFilesystemUsage; projects: ProjectDiskUsage[] }) => {
    const sorted = useMemo(() => [...projects].sort((a, b) => b.totalBytes - a.totalBytes), [projects]);
    const usedPct = fs.sizeBytes > 0 ? (fs.usedBytes / fs.sizeBytes) * 100 : 0;

    // Break the drive's used space into per-project sections plus an "other" (system / unattributed)
    // section; the remaining empty track is free space.
    const sections = useMemo(() => {
        if (fs.sizeBytes <= 0) return [] as { value: number; color: string; label: string; bytes: number }[];
        const projSections = sorted.map((p, idx) => ({
            value: (p.totalBytes / fs.sizeBytes) * 100,
            color: PROJECT_PALETTE[idx % PROJECT_PALETTE.length],
            label: p.projectId,
            bytes: p.totalBytes,
        }));
        const projSum = sorted.reduce((acc, p) => acc + p.totalBytes, 0);
        const otherBytes = Math.max(0, fs.usedBytes - projSum);
        if (otherBytes > 0) projSections.push({ value: (otherBytes / fs.sizeBytes) * 100, color: 'gray.5', label: 'System / other', bytes: otherBytes });
        return projSections;
    }, [sorted, fs]);

    return (
        <Card withBorder>
            <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap">
                        <Text fw={700}>{fs.device}</Text>
                        <Badge variant="light" color="gray">
                            {fs.mountpoint}
                        </Badge>
                        <Badge variant="outline" color="gray">
                            {fs.fstype}
                        </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                        {formatBytes(fs.usedBytes)} used / {formatBytes(fs.availBytes)} free / {formatBytes(fs.sizeBytes)} total ({usedPct.toFixed(1)}%)
                    </Text>
                </Group>

                <Progress.Root size="xl">
                    {sections.map((s, idx) => (
                        <Tooltip key={`${s.label}-${idx}`} label={`${s.label}: ${formatBytes(s.bytes)}`}>
                            <Progress.Section value={s.value} color={s.color} />
                        </Tooltip>
                    ))}
                </Progress.Root>

                {sorted.length === 0 ? (
                    <Text size="sm" c="dimmed">
                        No project data on this filesystem.
                    </Text>
                ) : (
                    <Accordion variant="contained">
                        {sorted.map((p) => (
                            <ProjectBreakdown key={`${p.projectId}|${p.device}|${p.mountpoint}`} project={p} driveSize={fs.sizeBytes} />
                        ))}
                    </Accordion>
                )}
            </Stack>
        </Card>
    );
};

const NodeDetailPage = () => {
    const params = useParams();
    const nodeId = params.nodeId as string;
    const clusterCtx = useCluster();
    const api = useAPI();

    const [rangeMs, setRangeMs] = useState<number>(TIME_RANGES[1].ms);
    const [metrics, setMetrics] = useState<Partial<Record<NodeMetricKind, ObservabilityMetricsResult>>>({});
    const [storage, setStorage] = useState<NodeStorageSpec | null>(null);
    const [series, setSeries] = useState<ObservabilityMetricsResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [snapshotting, setSnapshotting] = useState(false);

    const node = clusterCtx.nodes.find((n) => n.nodeId === nodeId);
    const health = clusterCtx.healthById[nodeId];

    const refresh = useCallback(async () => {
        if (!api.token) return;
        setLoading(true);
        const now = Date.now();
        const start = `${Math.floor((now - rangeMs) / 1000)}`;
        const end = `${Math.floor(now / 1000)}`;
        const step = rangeMs > 24 * 60 * 60 * 1000 ? '1h' : rangeMs > 6 * 60 * 60 * 1000 ? '10m' : '1m';
        try {
            const [cpu, mem, net, disk, storageRes, seriesRes] = await Promise.all([
                api.get(API_ROUTES.GET_NODE_METRICS, {}, { nodeId, metric: 'cpu', start, end, step }),
                api.get(API_ROUTES.GET_NODE_METRICS, {}, { nodeId, metric: 'mem', start, end, step }),
                api.get(API_ROUTES.GET_NODE_METRICS, {}, { nodeId, metric: 'net', start, end, step }),
                api.get(API_ROUTES.GET_NODE_METRICS, {}, { nodeId, metric: 'disk', start, end, step }),
                api.get(API_ROUTES.GET_NODE_STORAGE, {}, { nodeId }),
                api.get(API_ROUTES.GET_NODE_STORAGE_SERIES, {}, { nodeId, start, end, step }),
            ]);
            setMetrics({ cpu, mem, net, disk });
            if (storageRes) setStorage(storageRes);
            setSeries(seriesRes ?? { metric: 'disk', series: [] });
        } finally {
            setLoading(false);
        }
    }, [api, nodeId, rangeMs]);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 30000);
        return () => clearInterval(interval);
    }, [refresh]);

    const takeSnapshot = async () => {
        setSnapshotting(true);
        try {
            const spec = await api.post(API_ROUTES.POST_NODE_STORAGE_SNAPSHOT, {}, { nodeId });
            if (spec) setStorage(spec);
        } finally {
            setSnapshotting(false);
        }
    };

    // Group each project's usage under the filesystem it lives on; anything whose mount doesn't match
    // a listed filesystem is surfaced under a synthetic "unmatched" bucket so nothing is hidden.
    const { fsToProjects, unmatched } = useMemo(() => {
        const map = new Map<string, ProjectDiskUsage[]>();
        const knownFs = new Set((storage?.filesystems ?? []).map((f) => fsKey(f.device, f.mountpoint)));
        const orphans: ProjectDiskUsage[] = [];
        for (const p of storage?.projects ?? []) {
            const key = fsKey(p.device, p.mountpoint);
            if (knownFs.has(key)) {
                const arr = map.get(key) ?? [];
                arr.push(p);
                map.set(key, arr);
            } else {
                orphans.push(p);
            }
        }
        return { fsToProjects: map, unmatched: orphans };
    }, [storage]);

    const seriesChart = useMemo(() => {
        const s = series?.series ?? [];
        if (s.length === 0) return { data: [] as Record<string, number | string>[], defs: [] as { name: string; color: string }[] };
        const byTime = new Map<number, Record<string, number | string>>();
        const defs = s.map((entry, idx) => ({ name: projectLabel(entry.labels.projectId ?? `series ${idx + 1}`), color: entry.labels.projectId === '__total__' ? 'dark.4' : PROJECT_PALETTE[idx % PROJECT_PALETTE.length] }));
        s.forEach((entry, idx) => {
            const name = defs[idx].name;
            for (const point of entry.values) {
                const row = byTime.get(point.t) ?? { time: new Date(point.t * 1000).toLocaleString() };
                row[name] = point.v;
                byTime.set(point.t, row);
            }
        });
        const data = Array.from(byTime.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, row]) => row);
        return { data, defs };
    }, [series]);

    return (
        <Stack>
            <Group gap="xs">
                <Anchor component={Link} to="/nodes" c="dimmed">
                    <Group gap={4}>
                        <MdArrowBack />
                        <Text>Nodes</Text>
                    </Group>
                </Anchor>
            </Group>
            <Group justify="space-between" align="center">
                <Group gap="sm">
                    {node?.isLeader && (
                        <Tooltip label="Leader">
                            <span style={{ display: 'inline-flex', color: 'var(--mantine-color-yellow-6)' }}>
                                <MdOutlineStar />
                            </span>
                        </Tooltip>
                    )}
                    <Title order={2}>{nodeId}</Title>
                    {node && (
                        <Badge variant="light" color={node.isLeader ? 'yellow' : 'gray'}>
                            {node.isLeader ? 'Leader' : 'Follower'}
                        </Badge>
                    )}
                    {health && (
                        <Badge variant="light" color={health.reachable ? 'green' : 'red'}>
                            {health.reachable ? 'Reachable' : 'Unreachable'}
                        </Badge>
                    )}
                </Group>
                <Group>
                    <SegmentedControl value={String(rangeMs)} onChange={(v) => setRangeMs(Number(v))} data={TIME_RANGES.map((r) => ({ value: String(r.ms), label: r.label }))} />
                    <Tooltip label="Refresh">
                        <ActionIcon variant="light" size="lg" onClick={refresh} loading={loading}>
                            <MdOutlineRefresh />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>

            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Metrics unavailable">
                    Node metrics are served by the leader. No leader is currently reachable.
                </Alert>
            )}

            <SimpleGrid cols={{ base: 1, md: 2 }}>
                {METRIC_DEFS.map((def) => (
                    <MetricChart key={def.kind} def={def} result={metrics[def.kind]} />
                ))}
            </SimpleGrid>

            <Group justify="space-between" align="center" mt="md">
                <Title order={3}>Storage</Title>
                <Group gap="sm">
                    {storage && (
                        <Text size="sm" c="dimmed">
                            Snapshot {relativeTime(storage.capturedAt)}
                        </Text>
                    )}
                    <Button leftSection={<MdOutlineCameraAlt />} variant="light" onClick={takeSnapshot} loading={snapshotting}>
                        Take snapshot
                    </Button>
                </Group>
            </Group>

            {storage === null ? (
                <Center py="xl">
                    <Loader />
                </Center>
            ) : storage.filesystems.length === 0 && unmatched.length === 0 ? (
                <Text c="dimmed">No storage data reported for this node yet. Take a snapshot to scan now.</Text>
            ) : (
                <Stack>
                    {storage.filesystems.map((fs) => (
                        <FilesystemCard key={fsKey(fs.device, fs.mountpoint)} fs={fs} projects={fsToProjects.get(fsKey(fs.device, fs.mountpoint)) ?? []} />
                    ))}
                    {unmatched.length > 0 && (
                        <Card withBorder>
                            <Stack gap="sm">
                                <Text fw={700}>Other project storage</Text>
                                <Text size="sm" c="dimmed">
                                    Usage on filesystems not reported by node_exporter.
                                </Text>
                                <Accordion variant="contained">
                                    {unmatched
                                        .sort((a, b) => b.totalBytes - a.totalBytes)
                                        .map((p) => (
                                            <ProjectBreakdown key={`${p.projectId}|${p.device}|${p.mountpoint}`} project={p} driveSize={0} />
                                        ))}
                                </Accordion>
                            </Stack>
                        </Card>
                    )}
                </Stack>
            )}

            <Card withBorder mt="md">
                <Title order={5} mb="sm">
                    Project disk usage over time
                </Title>
                {seriesChart.data.length === 0 ? (
                    <Center py="xl">
                        <Text c="dimmed">No time-series storage data yet.</Text>
                    </Center>
                ) : (
                    <LineChart h={280} data={seriesChart.data} dataKey="time" series={seriesChart.defs} curveType="monotone" withDots={false} yAxisLabel="Bytes" valueFormatter={formatBytes} withLegend />
                )}
            </Card>
        </Stack>
    );
};

export default NodeDetailPage;
