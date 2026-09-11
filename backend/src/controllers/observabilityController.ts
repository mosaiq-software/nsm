import { config } from '@/config';
import { ObservabilityLogsResult, ObservabilityMetricsResult } from '@mosaiq/nsm-common/types';

// Selector identifying a deployment (in precedence order). All queries run on the leader, where
// the Loki/Prometheus stack lives.
export interface ObservabilitySelector {
    projectInstanceId?: string;
    serviceInstanceId?: string;
    projectId?: string;
}

export type MetricKind = 'cpu' | 'mem' | 'net';

// Loki label stream selector, e.g. {projectInstanceId="abc"}. Precedence: service instance is
// most specific, then project instance, then project.
const labelSelector = (s: ObservabilitySelector): string => {
    if (s.serviceInstanceId) return `serviceInstanceId="${s.serviceInstanceId}"`;
    if (s.projectInstanceId) return `projectInstanceId="${s.projectInstanceId}"`;
    if (s.projectId) return `projectId="${s.projectId}"`;
    throw new Error('a selector is required (serviceInstanceId | projectInstanceId | projectId)');
};

export const queryLogs = async (s: ObservabilitySelector, startNs: string, endNs: string, limit = 500): Promise<ObservabilityLogsResult> => {
    const query = `{${labelSelector(s)}}`;
    const url = `${config.lokiUrl}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startNs}&end=${endNs}&limit=${limit}&direction=backward`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`loki ${res.status}`);
    const body: any = await res.json();
    const lines: ObservabilityLogsResult['lines'] = [];
    for (const stream of body?.data?.result || []) {
        for (const [ts, line] of stream.values || []) lines.push({ ts, line, labels: stream.stream || {} });
    }
    lines.sort((a, b) => Number(b.ts) - Number(a.ts));
    return { lines };
};

const metricExpr = (metric: MetricKind, inner: string): string => {
    switch (metric) {
        case 'cpu':
            return `sum(rate(container_cpu_usage_seconds_total{${inner}}[1m]))`;
        case 'mem':
            return `sum(container_memory_usage_bytes{${inner}})`;
        case 'net':
            return `sum(rate(container_network_receive_bytes_total{${inner}}[1m]))`;
    }
};

export const queryMetric = async (s: ObservabilitySelector, metric: MetricKind, startS: string, endS: string, step = '30s'): Promise<ObservabilityMetricsResult> => {
    const expr = metricExpr(metric, labelSelector(s));
    const url = `${config.prometheusUrl}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${startS}&end=${endS}&step=${step}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`prometheus ${res.status}`);
    const body: any = await res.json();
    const series = (body?.data?.result || []).map((r: any) => ({
        labels: r.metric || {},
        values: (r.values || []).map(([t, v]: [number, string]) => ({ t, v: Number(v) })),
    }));
    return { metric, series };
};
