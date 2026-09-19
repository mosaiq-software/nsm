import { useQuery, useQueries } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { NodeMetricKind, ObservabilityMetricsResult } from '@mosaiq/nsm-common/types';

const METRICS_REFRESH_MS = 30000;
const STORAGE_REFRESH_MS = 30000;

// Compute the Prometheus-style start/end/step window for a range in ms. Recomputed on every fetch so
// polling always requests a window relative to "now".
const windowFor = (rangeMs: number) => {
    const now = Date.now();
    return {
        start: `${Math.floor((now - rangeMs) / 1000)}`,
        end: `${Math.floor(now / 1000)}`,
        step: rangeMs > 24 * 60 * 60 * 1000 ? '1h' : rangeMs > 6 * 60 * 60 * 1000 ? '10m' : '1m',
    };
};

// The four node-level metric charts, fetched in parallel and polled every 30s. Returns a map keyed by
// metric kind plus aggregate fetching/refetch controls for the shared refresh button.
export const useNodeMetrics = (nodeId: string, rangeMs: number) => {
    const api = useAPI();
    const kinds: NodeMetricKind[] = ['cpu', 'mem', 'net', 'disk'];

    const results = useQueries({
        queries: kinds.map((metric) => ({
            queryKey: queryKeys.nodeMetrics(nodeId, metric, String(rangeMs)),
            queryFn: async () => {
                const { start, end, step } = windowFor(rangeMs);
                return (await api.get(API_ROUTES.GET_NODE_METRICS, {}, { nodeId, metric, start, end, step })) ?? null;
            },
            enabled: !!api.token && !!nodeId,
            refetchInterval: METRICS_REFRESH_MS,
        })),
    });

    const metrics: Partial<Record<NodeMetricKind, ObservabilityMetricsResult>> = {};
    kinds.forEach((kind, i) => {
        const data = results[i].data;
        if (data) metrics[kind] = data;
    });

    const isFetching = results.some((r) => r.isFetching);
    const refetch = async () => {
        await Promise.all(results.map((r) => r.refetch()));
    };

    return { metrics, isFetching, refetch };
};

export const useNodeStorage = (nodeId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.nodeStorage(nodeId),
        queryFn: async () => (await api.get(API_ROUTES.GET_NODE_STORAGE, {}, { nodeId })) ?? null,
        enabled: !!api.token && !!nodeId,
        refetchInterval: STORAGE_REFRESH_MS,
    });
};

export const useNodeStorageSeries = (nodeId: string, rangeMs: number) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.nodeStorageSeries(nodeId, String(rangeMs)),
        queryFn: async () => {
            const { start, end, step } = windowFor(rangeMs);
            return (await api.get(API_ROUTES.GET_NODE_STORAGE_SERIES, {}, { nodeId, start, end, step })) ?? { metric: 'disk', series: [] };
        },
        enabled: !!api.token && !!nodeId,
        refetchInterval: STORAGE_REFRESH_MS,
    });
};

export const useNodeConfig = (nodeId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.nodeConfig(nodeId),
        queryFn: async () => (await api.get(API_ROUTES.GET_NODE_CONFIG, { nodeId })) ?? null,
        enabled: !!api.token && !!nodeId && enabled,
    });
};

export const useNodePortReservations = (nodeId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.nodePortReservations(nodeId),
        queryFn: async () => (await api.get(API_ROUTES.GET_NODE_PORT_RESERVATIONS, { nodeId })) ?? [],
        enabled: !!api.token && !!nodeId,
    });
};

export const useJoinInfo = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.joinInfo(),
        queryFn: async () => (await api.get(API_ROUTES.GET_JOIN_INFO, {})) ?? null,
        enabled: !!api.token && enabled,
    });
};
