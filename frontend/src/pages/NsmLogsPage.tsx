import { ActionIcon, Alert, Card, Center, Code, Group, Loader, ScrollArea, SegmentedControl, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ObservabilityLogsResult } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useCluster } from '@/contexts/cluster-context';
import { useAPI } from '@/utils/api';
import { MdOutlineRefresh } from 'react-icons/md';

const TIME_RANGES: { label: string; ms: number }[] = [
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
];

const ALL_NODES = '__all__';

const NsmLogsPage = () => {
    const clusterCtx = useCluster();
    const api = useAPI();

    const [nodeId, setNodeId] = useState<string>(ALL_NODES);
    const [rangeMs, setRangeMs] = useState<number>(TIME_RANGES[1].ms);
    const [logs, setLogs] = useState<ObservabilityLogsResult | null>(null);
    const [loading, setLoading] = useState(false);

    const refresh = async () => {
        setLoading(true);
        const now = Date.now();
        const start = now - rangeMs;
        try {
            const res = await api.get(API_ROUTES.GET_NSM_LOGS, {}, {
                nodeId: nodeId === ALL_NODES ? undefined : nodeId,
                start: `${start * 1_000_000}`,
                end: `${now * 1_000_000}`,
                limit: 500,
            });
            setLogs(res ?? { lines: [] });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 15000);
        return () => clearInterval(interval);
    }, [nodeId, rangeMs]);

    const nodeOptions = [
        { value: ALL_NODES, label: 'All nodes' },
        ...clusterCtx.nodes.map((n) => ({ value: n.nodeId, label: `${n.nodeId}${n.isLeader ? ' (leader)' : ''}` })),
    ];

    return (
        <Stack>
            <Title order={2}>NSM Logs</Title>
            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Observability unavailable">
                    Logs are served by the leader. No leader is currently reachable.
                </Alert>
            )}
            <Group align="flex-end" justify="space-between">
                <Group align="flex-end">
                    <Select label="Node" data={nodeOptions} value={nodeId} onChange={(v) => setNodeId(v || ALL_NODES)} w={280} />
                    <Stack gap={2}>
                        <Text fz="var(--input-label-size, var(--mantine-font-size-sm))">Time Range</Text>
                        <SegmentedControl value={String(rangeMs)} onChange={(v) => setRangeMs(Number(v))} data={TIME_RANGES.map((r) => ({ value: String(r.ms), label: r.label }))} />
                    </Stack>
                </Group>
                <Tooltip label="Refresh">
                    <ActionIcon variant="light" size="lg" onClick={refresh} loading={loading}>
                        <MdOutlineRefresh />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <Card withBorder>
                <Title order={5} mb="sm">
                    Control-plane logs
                </Title>
                {!logs ? (
                    <Center py="xl">
                        <Loader />
                    </Center>
                ) : logs.lines.length === 0 ? (
                    <Center py="xl">
                        <Text c="dimmed">No logs for this selection.</Text>
                    </Center>
                ) : (
                    <ScrollArea.Autosize mah={600} type="auto">
                        <Code block>
                            {logs.lines
                                .slice()
                                .reverse()
                                .map((line) => `${new Date(Number(line.ts) / 1_000_000).toLocaleString()}  ${line.line}`)
                                .join('\n')}
                        </Code>
                    </ScrollArea.Autosize>
                )}
            </Card>
        </Stack>
    );
};

export default NsmLogsPage;
