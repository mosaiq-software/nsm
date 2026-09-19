import { config } from '@/config';
import { LogEntry, LogFacet, LogFacetsRequest, LogFacetsResult, LogFilter, LogQueryRequest, LogQueryResult, LogSelector, NodeFilesystemUsage, NodeMetricKind, NodeStorageSpec, ObservabilityLogsResult, ObservabilityMetricsResult, ProjectDiskUsage, ProjectResourceUsage } from '@mosaiq/nsm-common/types';

// Selector identifying a deployment (in precedence order). All queries run on the leader, where
// the Loki/Prometheus stack lives.
export interface ObservabilitySelector {
    projectInstanceId?: string;
    serviceInstanceId?: string;
    projectId?: string;
}

export type MetricKind = 'cpu' | 'mem' | 'net' | 'storage';

// Loki label stream selector, e.g. {projectInstanceId="abc"}. Precedence: service instance is
// most specific, then project instance, then project.
const labelSelector = (s: ObservabilitySelector): string => {
    if (s.serviceInstanceId) return `serviceInstanceId="${s.serviceInstanceId}"`;
    if (s.projectInstanceId) return `projectInstanceId="${s.projectInstanceId}"`;
    if (s.projectId) return `projectId="${s.projectId}"`;
    throw new Error('a selector is required (serviceInstanceId | projectInstanceId | projectId)');
};

// Runs a LogQL range query against Loki for the given stream selector and returns lines newest-first.
const queryLoki = async (query: string, startNs: string, endNs: string, limit: number): Promise<ObservabilityLogsResult> => {
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

export const queryLogs = async (s: ObservabilitySelector, startNs: string, endNs: string, limit = 500): Promise<ObservabilityLogsResult> => {
    return queryLoki(`{${labelSelector(s)}}`, startNs, endNs, limit);
};

// nsmd control-plane logs, shipped to Loki by Alloy with source="nsmd" (and per-node nodeId).
// When a nodeId is given, restrict to that node; otherwise return logs across all nodes.
export const queryNsmLogs = async (nodeId: string | undefined, startNs: string, endNs: string, limit = 500): Promise<ObservabilityLogsResult> => {
    const selector = nodeId ? `source="nsmd",nodeId="${nodeId}"` : `source="nsmd"`;
    return queryLoki(`{${selector}}`, startNs, endNs, limit);
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

// The per-project disk gauge is only labeled with projectId (no instance/service labels), so the
// storage metric can only be scoped at the project level.
const projectSelector = (s: ObservabilitySelector): string => {
    if (!s.projectId) throw new Error('storage metric requires projectId scope');
    return `projectId="${s.projectId}"`;
};

export const queryMetric = async (s: ObservabilitySelector, metric: MetricKind, startS: string, endS: string, step = '30s'): Promise<ObservabilityMetricsResult> => {
    const expr = metric === 'storage' ? `sum(nsm_project_disk_usage_bytes{${projectSelector(s)}})` : metricExpr(metric, labelSelector(s));
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

// === Node-level metrics + storage spec ===

// Escape a value for use inside a PromQL double-quoted label matcher.
const escapePromLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Real (non-pseudo) filesystems only: excludes tmpfs/overlay/cgroup/etc so per-drive totals reflect
// actual storage. Applied to node_exporter node_filesystem_* series.
const REAL_FS_FILTER = `fstype!~"tmpfs|overlay|squashfs|devtmpfs|ramfs|autofs|mqueue|debugfs|tracefs|securityfs|pstore|bpf|nsfs|fusectl|binfmt_misc|configfs|hugetlbfs|devpts|rpc_pipefs|proc|sysfs|cgroup|cgroup2"`;

// Generic Prometheus range query -> ObservabilityMetricsResult (metric left blank; callers set it).
const promQueryRange = async (expr: string, startS: string, endS: string, step: string): Promise<ObservabilityMetricsResult> => {
    const url = `${config.prometheusUrl}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${startS}&end=${endS}&step=${step}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`prometheus ${res.status}`);
    const body: any = await res.json();
    const series = (body?.data?.result || []).map((r: any) => ({
        labels: r.metric || {},
        values: (r.values || []).map(([t, v]: [number, string]) => ({ t, v: Number(v) })),
    }));
    return { metric: '', series };
};

// Generic Prometheus instant query -> flat list of labelled samples.
const promQueryInstant = async (expr: string): Promise<{ metric: Record<string, string>; value: number }[]> => {
    const url = `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`prometheus ${res.status}`);
    const body: any = await res.json();
    return (body?.data?.result || []).map((r: any) => ({ metric: r.metric || {}, value: Number(r.value?.[1] ?? 0) }));
};

// Host-level PromQL from node_exporter for one node. CPU is utilization (fraction of cores),
// memory is used bytes, network is total rx+tx bytes/s, disk is total used bytes across real FSes.
const nodeMetricExpr = (metric: NodeMetricKind, nodeSel: string): string => {
    switch (metric) {
        case 'cpu':
            return `(1 - avg(rate(node_cpu_seconds_total{mode="idle",${nodeSel}}[1m])))`;
        case 'mem':
            return `(node_memory_MemTotal_bytes{${nodeSel}} - node_memory_MemAvailable_bytes{${nodeSel}})`;
        case 'net':
            return `(sum(rate(node_network_receive_bytes_total{${nodeSel}}[1m])) + sum(rate(node_network_transmit_bytes_total{${nodeSel}}[1m])))`;
        case 'disk':
            return `(sum(node_filesystem_size_bytes{${nodeSel},${REAL_FS_FILTER}}) - sum(node_filesystem_avail_bytes{${nodeSel},${REAL_FS_FILTER}}))`;
    }
};

export const queryNodeMetric = async (nodeId: string, metric: NodeMetricKind, startS: string, endS: string, step = '30s'): Promise<ObservabilityMetricsResult> => {
    if (!nodeId) throw new Error('nodeId is required');
    const nodeSel = `nodeId="${escapePromLabel(nodeId)}"`;
    const result = await promQueryRange(nodeMetricExpr(metric, nodeSel), startS, endS, step);
    return { ...result, metric };
};

// Latest storage tree for a node, assembled from Prometheus instant queries (no live disk scan):
// per-filesystem capacity from node_exporter, per-project volume/code from the nsmd gauge.
export const getNodeStorageSpec = async (nodeId: string): Promise<NodeStorageSpec> => {
    if (!nodeId) throw new Error('nodeId is required');
    const nodeSel = `nodeId="${escapePromLabel(nodeId)}"`;
    const [sizeVec, availVec, projVec] = await Promise.all([
        promQueryInstant(`node_filesystem_size_bytes{${nodeSel},${REAL_FS_FILTER}}`),
        promQueryInstant(`node_filesystem_avail_bytes{${nodeSel},${REAL_FS_FILTER}}`),
        promQueryInstant(`nsm_project_disk_usage_bytes{${nodeSel}}`),
    ]);

    const fsKey = (m: Record<string, string>) => `${m.device || ''}|${m.mountpoint || ''}`;
    const fsMap = new Map<string, NodeFilesystemUsage>();
    const ensureFs = (m: Record<string, string>): NodeFilesystemUsage => {
        const key = fsKey(m);
        let entry = fsMap.get(key);
        if (!entry) {
            entry = { device: m.device || '', mountpoint: m.mountpoint || '', fstype: m.fstype || '', sizeBytes: 0, usedBytes: 0, availBytes: 0 };
            fsMap.set(key, entry);
        }
        return entry;
    };
    for (const s of sizeVec) ensureFs(s.metric).sizeBytes = s.value;
    for (const a of availVec) ensureFs(a.metric).availBytes = a.value;
    for (const fs of fsMap.values()) fs.usedBytes = Math.max(0, fs.sizeBytes - fs.availBytes);

    const projMap = new Map<string, ProjectDiskUsage>();
    for (const p of projVec) {
        const projectId = p.metric.projectId || '';
        const device = p.metric.device || '';
        const mountpoint = p.metric.mountpoint || '';
        const key = `${projectId}|${device}|${mountpoint}`;
        let entry = projMap.get(key);
        if (!entry) {
            entry = { projectId, device, mountpoint, volumeBytes: 0, codeBytes: 0, totalBytes: 0 };
            projMap.set(key, entry);
        }
        if (p.metric.kind === 'volume') entry.volumeBytes = p.value;
        else if (p.metric.kind === 'code') entry.codeBytes = p.value;
        entry.totalBytes = entry.volumeBytes + entry.codeBytes;
    }

    return { nodeId, capturedAt: Date.now(), filesystems: [...fsMap.values()], projects: [...projMap.values()] };
};

// Per-project disk usage over time for a node (one series per project) plus a node-summed series
// (projectId="__total__"), so the UI can chart how storage changes per project and in aggregate.
export const queryNodeStorageSeries = async (nodeId: string, startS: string, endS: string, step = '30s'): Promise<ObservabilityMetricsResult> => {
    if (!nodeId) throw new Error('nodeId is required');
    const nodeSel = `nodeId="${escapePromLabel(nodeId)}"`;
    const [perProject, total] = await Promise.all([
        promQueryRange(`sum by (projectId) (nsm_project_disk_usage_bytes{${nodeSel}})`, startS, endS, step),
        promQueryRange(`sum(nsm_project_disk_usage_bytes{${nodeSel}})`, startS, endS, step),
    ]);
    const totalSeries = total.series.map((s) => ({ labels: { projectId: '__total__' }, values: s.values }));
    return { metric: 'disk', series: [...perProject.series, ...totalSeries] };
};

// === Per-project resource usage (for allocation checks and the allocation UIs) ===

// Current usage for a project across the cluster: CPU as cores (5m-smoothed cAdvisor rate),
// memory as instantaneous used bytes, storage as the summed nsmd per-project disk gauge
// (volume + deployed code across nodes). Missing series read as 0.
export const getProjectResourceUsage = async (projectId: string): Promise<ProjectResourceUsage> => {
    if (!projectId) throw new Error('projectId is required');
    const sel = `projectId="${escapePromLabel(projectId)}"`;
    const [cpuVec, memVec, storageVec] = await Promise.all([
        promQueryInstant(`sum(rate(container_cpu_usage_seconds_total{${sel}}[5m]))`),
        promQueryInstant(`sum(container_memory_usage_bytes{${sel}})`),
        promQueryInstant(`sum(nsm_project_disk_usage_bytes{${sel}})`),
    ]);
    const first = (v: { value: number }[]): number => (v.length ? v[0].value : 0);
    return { cpuCores: first(cpuVec), memoryBytes: first(memVec), storageBytes: first(storageVec) };
};

// === Structured log query (Datadog-style viewer) ===

// Escape a user-supplied value for use inside a LogQL double-quoted string literal.
const escapeLogQL = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// nsmd logs are pino JSON, so their fields (area/action/level/...) require a `| json` stage to
// filter/aggregate on. App-container logs are raw text; only their Loki stream labels are queryable.
const isJsonSource = (s: LogSelector): boolean => s.source === 'nsmd';

// Base Loki stream selector body (without braces) for a log selector, in precedence order.
const baseSelector = (s: LogSelector): string => {
    if (s.source === 'nsmd') return `source="nsmd"`;
    if (s.serviceInstanceId) return `serviceInstanceId="${escapeLogQL(s.serviceInstanceId)}"`;
    if (s.projectInstanceId) return `projectInstanceId="${escapeLogQL(s.projectInstanceId)}"`;
    if (s.projectId) return `projectId="${escapeLogQL(s.projectId)}"`;
    throw new Error('a selector is required (source | serviceInstanceId | projectInstanceId | projectId)');
};

// Field/label identifiers are interpolated unquoted into LogQL (label filters, `sum by (...)`), so
// they must be strict identifiers to prevent query injection.
const assertField = (field: string): string => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) throw new Error(`invalid field name: ${field}`);
    return field;
};

const OP_TO_LOGQL: Record<LogFilter['op'], string> = { eq: '=', neq: '!=', match: '=~', nmatch: '!~' };

// Builds the shared LogQL pipeline (selector + line filter + json + field filters + level floor)
// used by both the log query and the facet aggregations.
const buildLogPipeline = (selector: LogSelector, search?: string, filters?: LogFilter[], levelMin?: number): string => {
    const json = isJsonSource(selector);
    let q = `{${baseSelector(selector)}}`;
    if (search && search.trim().length) q += ` |= "${escapeLogQL(search)}"`;
    if (json) q += ` | json`;
    for (const f of filters || []) {
        q += ` | ${assertField(f.field)}${OP_TO_LOGQL[f.op] || '='}"${escapeLogQL(f.value)}"`;
    }
    if (json && typeof levelMin === 'number' && !Number.isNaN(levelMin)) q += ` | level >= ${Math.trunc(levelMin)}`;
    return q;
};

// Parse a pino/JSON log line into a fields object; undefined for non-object / non-JSON (raw text).
const parseFields = (line: string): LogEntry['fields'] => {
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

// Range vector duration (seconds) covering [startNs, endNs], floored to 1s.
const rangeSeconds = (startNs: string, endNs: string): number => {
    const span = Number((BigInt(endNs) - BigInt(startNs)) / 1_000_000_000n);
    return Math.max(1, span);
};

export const queryStructuredLogs = async (req: LogQueryRequest): Promise<LogQueryResult> => {
    const query = buildLogPipeline(req.selector, req.search, req.filters, req.levelMin);
    const limit = req.limit && req.limit > 0 ? Math.min(req.limit, 5000) : 200;
    // Backward pagination: fetch entries strictly older than the cursor (end is exclusive in Loki).
    const end = req.cursorNs && req.cursorNs.length ? req.cursorNs : req.endNs;
    const url = `${config.lokiUrl}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${req.startNs}&end=${end}&limit=${limit}&direction=backward`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`loki ${res.status}`);
    const body: any = await res.json();
    const entries: LogEntry[] = [];
    for (const stream of body?.data?.result || []) {
        for (const [ts, line] of stream.values || []) entries.push({ ts, line, labels: stream.stream || {}, fields: parseFields(line) });
    }
    entries.sort((a, b) => (BigInt(a.ts) < BigInt(b.ts) ? 1 : -1)); // newest first
    // Only advertise a cursor when the page was full (more may exist); step 1ns before the oldest.
    const nextCursorNs = entries.length >= limit ? (BigInt(entries[entries.length - 1].ts) - 1n).toString() : undefined;
    return { entries, nextCursorNs };
};

// Instant Loki metric query returning a vector; used for facet value counts.
const lokiInstantVector = async (expr: string, timeNs: string): Promise<{ metric: Record<string, string>; value: number }[]> => {
    const url = `${config.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(expr)}&time=${timeNs}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`loki ${res.status}`);
    const body: any = await res.json();
    return (body?.data?.result || []).map((r: any) => ({ metric: r.metric || {}, value: Number(r.value?.[1] ?? 0) }));
};

export const queryLogFacets = async (req: LogFacetsRequest): Promise<LogFacetsResult> => {
    const range = `${rangeSeconds(req.startNs, req.endNs)}s`;

    // Facet counts for a field must ignore that field's own selections, otherwise picking one value
    // (e.g. level=debug) collapses the group to that single value and hides the other options the
    // user would OR against. Filters from *other* groups still apply (AND across groups).
    const facets: LogFacet[] = await Promise.all(
        (req.fields || []).map(async (rawField) => {
            const field = assertField(rawField);
            const otherFilters = (req.filters || []).filter((f) => f.field !== field);
            const levelMin = field === 'level' ? undefined : req.levelMin;
            const pipeline = buildLogPipeline(req.selector, req.search, otherFilters, levelMin);
            const expr = `sum by (${field}) (count_over_time(${pipeline} [${range}]))`;
            const vec = await lokiInstantVector(expr, req.endNs);
            const values = vec
                .map((r) => ({ value: r.metric[field] ?? '', count: r.value }))
                .filter((v) => v.value !== '')
                .sort((a, b) => b.count - a.count)
                .slice(0, 100);
            return { field, values };
        })
    );

    // Total reflects the fully-filtered result set (all groups ANDed together).
    const fullPipeline = buildLogPipeline(req.selector, req.search, req.filters, req.levelMin);
    const totalVec = await lokiInstantVector(`sum (count_over_time(${fullPipeline} [${range}]))`, req.endNs);
    const total = totalVec.length ? totalVec[0].value : 0;
    return { facets, total };
};
