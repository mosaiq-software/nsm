import { ActionIcon, Card, Center, Group, SegmentedControl, SimpleGrid, Text, Title, Tooltip } from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { NodeMetricKind, ObservabilityMetricsResult } from '@mosaiq/nsm-common/types';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MdOutlineRefresh } from 'react-icons/md';
import { useNodeMetrics } from '@/hooks/queries/nodeHooks';
import { formatAxisTime, formatBytes, formatBytesPerSec, formatPercent01 } from '@/utils/format';

const TIME_RANGES: { label: string; ms: number }[] = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const METRIC_DEFS: { kind: NodeMetricKind; title: string; yLabel: string; color: string; format: (v: number) => string }[] = [
    { kind: 'cpu', title: 'CPU', yLabel: 'CPU utilization', color: 'blue.6', format: formatPercent01 },
    { kind: 'mem', title: 'Memory', yLabel: 'Memory used', color: 'teal.6', format: formatBytes },
    { kind: 'net', title: 'Network', yLabel: 'Throughput', color: 'grape.6', format: formatBytesPerSec },
    { kind: 'disk', title: 'Disk', yLabel: 'Disk used', color: 'orange.6', format: formatBytes },
];

// Collapse a (possibly multi-series) node metric result into one { time, value } line by summing
// series per timestamp - node-level expressions return a single series, but this is robust either way.
function singleSeries(result: ObservabilityMetricsResult | undefined, rangeMs: number): { time: string; value: number }[] {
    const byTime = new Map<number, number>();
    for (const s of result?.series ?? []) {
        for (const p of s.values) byTime.set(p.t, (byTime.get(p.t) ?? 0) + p.v);
    }
    return Array.from(byTime.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ time: formatAxisTime(t, rangeMs), value: v }));
}

const MetricChart = ({ def, result, rangeMs }: { def: (typeof METRIC_DEFS)[number]; result?: ObservabilityMetricsResult; rangeMs: number }) => {
    const data = useMemo(() => singleSeries(result, rangeMs), [result, rangeMs]);
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
                    strokeWidth={2}
                    tickLine="y"
                    gridAxis="y"
                    yAxisLabel={def.yLabel}
                    yAxisProps={{ width: 72 }}
                    xAxisProps={{ minTickGap: 40 }}
                    valueFormatter={def.format}
                />
            )}
        </Card>
    );
};

const NodeOverviewPage = () => {
    const params = useParams();
    const nodeId = params.nodeId as string;

    const [rangeMs, setRangeMs] = useState<number>(TIME_RANGES[1].ms);
    const { metrics, isFetching, refetch } = useNodeMetrics(nodeId, rangeMs);

    return (
        <>
            <Group justify="flex-end">
                <SegmentedControl value={String(rangeMs)} onChange={(v) => setRangeMs(Number(v))} data={TIME_RANGES.map((r) => ({ value: String(r.ms), label: r.label }))} />
                <Tooltip label="Refresh">
                    <ActionIcon variant="light" size="lg" onClick={() => void refetch()} loading={isFetching}>
                        <MdOutlineRefresh />
                    </ActionIcon>
                </Tooltip>
            </Group>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
                {METRIC_DEFS.map((def) => (
                    <MetricChart key={def.kind} def={def} result={metrics[def.kind]} rangeMs={rangeMs} />
                ))}
            </SimpleGrid>
        </>
    );
};

export default NodeOverviewPage;
