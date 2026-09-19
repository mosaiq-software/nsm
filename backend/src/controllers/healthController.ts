import crypto from 'crypto';
import {
    HealthCheckType,
    HealthStatus,
    NginxConfigLocationType,
    ProjectHealthCheck,
    ProjectHealthRollup,
    ProjectHealthSample,
    ProjectHealthSummary,
    ProjectNginxConfig,
    UptimeBucket,
    UptimeWindowKey,
    UptimeWindowSummary,
} from '@mosaiq/nsm-common/types';
import { getAllProjectsModel } from '@/persistence/projectPersistence';
import { getProjectInstancesByProjectIdModel } from '@/persistence/projectInstancePersistence';
import { getServiceInstancesByProjectInstanceIdModel } from '@/persistence/serviceInstancePersistence';
import {
    deleteHealthRollupsForProjectModel,
    deleteHealthSamplesForProjectModel,
    getLatestSamplesForProjectModel,
    getRollupsInRangeModel,
    getSamplesInRangeModel,
    insertHealthSamplesModel,
    pruneHealthRollupsModel,
    pruneHealthSamplesModel,
    upsertHealthRollupsModel,
} from '@/persistence/projectHealthPersistence';
import { execSafe } from '@/host/exec';
import { emitProjectEvent } from './webhookController';
import { buildHealthTransitionEvent } from './webhooks/events';
import { areaLog, serializeError } from '@/utils/log';

const healthLog = areaLog('health');

// How often the leader samples every project's health.
export const HEALTH_SAMPLE_INTERVAL_MS = 30_000;
// Raw 30s samples are kept only short-term; closed hours are rolled up into compact aggregates that
// are retained far longer. The rollup interval (hourly) is far smaller than raw retention, so every
// hour is rolled up many times before its raw is pruned - a rollup can never be missed.
export const RAW_RETENTION_MS = 48 * 60 * 60 * 1000; // 48h
export const ROLLUP_GRANULARITY_MS = 60 * 60 * 1000; // 1h buckets
export const ROLLUP_RETENTION_MS = 400 * 24 * 60 * 60 * 1000; // ~400d

const WINDOW_MS: Record<UptimeWindowKey, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
};

// Heatmap bucket size per window, chosen to keep the number of cells readable.
const BUCKET_MS: Record<UptimeWindowKey, number> = {
    '24h': 60 * 60 * 1000, // 24 hourly cells
    '7d': 6 * 60 * 60 * 1000, // 28 six-hour cells
    '30d': 24 * 60 * 60 * 1000, // 30 daily cells
    '90d': 24 * 60 * 60 * 1000, // 90 daily cells
};

const ALL_WINDOWS: UptimeWindowKey[] = ['24h', '7d', '30d', '90d'];

// A sample counts as "up" for uptime purposes whenever it is not fully DOWN (DEGRADED still serves).
const isUp = (status: HealthStatus): boolean => status !== HealthStatus.DOWN && status !== HealthStatus.UNKNOWN;

// The public URLs a project actually serves: only STATIC and PROXY locations are real endpoints.
// REDIRECT and CUSTOM locations are excluded (they are not the service itself).
export const buildProjectUrlTargets = (nginxConfig: ProjectNginxConfig | undefined): string[] => {
    const urls = new Set<string>();
    for (const server of nginxConfig?.servers ?? []) {
        const domain = (server.domain || '').trim();
        if (!domain) continue;
        for (const loc of server.locations ?? []) {
            if (loc.type !== NginxConfigLocationType.STATIC && loc.type !== NginxConfigLocationType.PROXY) continue;
            const path = loc.path || '/';
            const suffix = path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;
            urls.add(`https://${domain}${suffix}`);
        }
    }
    return [...urls];
};

// HTTP/TLS probe of one URL. Any response < 500 means the app is answering (UP). A 5xx is DOWN. A
// TLS-specific curl failure is DEGRADED (reachable but the certificate is bad); other transport
// failures (timeout, refused, DNS) are DOWN.
const TLS_CURL_EXITS = new Set([35, 51, 58, 59, 60, 66, 77, 83, 91]);

const probeUrl = async (url: string): Promise<{ status: HealthStatus; latencyMs?: number; detail?: string }> => {
    const cmd = `curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 10 ${JSON.stringify(url)}`;
    const { out, code } = await execSafe(cmd, 12_000);
    const token = out.trim().split('\n')[0]?.trim() || '';
    const [codeStr, timeStr] = token.split(/\s+/);
    const httpCode = parseInt(codeStr || '0', 10);
    const latencyMs = timeStr ? Math.round(parseFloat(timeStr) * 1000) : undefined;
    if (httpCode >= 200 && httpCode < 500) return { status: HealthStatus.UP, latencyMs, detail: `HTTP ${httpCode}` };
    if (httpCode >= 500) return { status: HealthStatus.DOWN, latencyMs, detail: `HTTP ${httpCode}` };
    if (TLS_CURL_EXITS.has(code)) return { status: HealthStatus.DEGRADED, detail: `TLS error (curl ${code})` };
    return { status: HealthStatus.DOWN, detail: `unreachable (curl ${code})` };
};

// Container checks derived from the project's active deployment instance: each service is UP when
// its actual container state matches the expected state, otherwise DOWN.
const containerChecks = async (projectId: string): Promise<Array<{ target: string; status: HealthStatus; detail?: string }>> => {
    const instances = await getProjectInstancesByProjectIdModel(projectId);
    const active = instances.find((i) => i.active);
    if (!active) return [];
    const services = await getServiceInstancesByProjectInstanceIdModel(active.id);
    return services.map((svc) => ({
        target: svc.serviceName,
        status: svc.actualContainerState === svc.expectedContainerState ? HealthStatus.UP : HealthStatus.DOWN,
        detail: `${svc.actualContainerState} (expected ${svc.expectedContainerState})`,
    }));
};

// Sample one project: probe every public URL and read every container's state, returning one
// sample row per target. Does not persist - the caller batches the inserts.
export const sampleProject = async (projectId: string, nginxConfig: ProjectNginxConfig | undefined): Promise<ProjectHealthSample[]> => {
    const ts = Date.now();
    const urls = buildProjectUrlTargets(nginxConfig);
    const urlProbes = await Promise.all(
        urls.map(async (url) => {
            const r = await probeUrl(url);
            return { checkType: HealthCheckType.URL, target: url, ...r };
        })
    );
    const containers = await containerChecks(projectId);
    const samples: ProjectHealthSample[] = [
        ...urlProbes.map((p) => ({ id: crypto.randomUUID(), projectId, checkType: p.checkType, target: p.target, status: p.status, latencyMs: p.latencyMs, detail: p.detail, ts })),
        ...containers.map((c) => ({ id: crypto.randomUUID(), projectId, checkType: HealthCheckType.CONTAINER, target: c.target, status: c.status, detail: c.detail, ts })),
    ];
    return samples;
};

// Simple bounded-concurrency map so a large cluster's sampling tick doesn't fan out unbounded.
const mapWithConcurrency = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
};

// Fire a health webhook event when a project's overall status changes. The fresh samples give the
// new overall; the latest stored samples (read before this tick is inserted) give the previous one.
// Must be awaited before the bulk insert so it compares against the prior tick, not the new one.
const detectHealthTransition = async (projectId: string, newSamples: ProjectHealthSample[]): Promise<void> => {
    try {
        const next = worstStatus(newSamples.map((s) => s.status));
        if (next === HealthStatus.UNKNOWN) return;
        const prevSamples = await getLatestSamplesForProjectModel(projectId);
        const prev = worstStatus(prevSamples.map((s) => s.status));
        if (prev === HealthStatus.UNKNOWN || prev === next) return;
        const event = buildHealthTransitionEvent(projectId, prev, next);
        if (event) void emitProjectEvent(event);
    } catch (e: any) {
        healthLog.warn({ action: 'health_transition_failed', projectId, err: serializeError(e) }, `health transition detection failed for ${projectId}`);
    }
};

// Leader cron entry point: sample every project and persist the results.
export const sampleAllProjects = async (): Promise<void> => {
    const projects = await getAllProjectsModel();
    if (!projects.length) return;
    const batches = await mapWithConcurrency(projects, 8, async (p) => {
        try {
            const nginxConfig = JSON.parse(p.nginxConfigJson || '{"servers":[]}') as ProjectNginxConfig;
            const samples = await sampleProject(p.id, nginxConfig);
            await detectHealthTransition(p.id, samples);
            return samples;
        } catch (e: any) {
            healthLog.warn({ action: 'sample_project_failed', projectId: p.id, err: serializeError(e) }, `health sample failed for ${p.id}`);
            return [] as ProjectHealthSample[];
        }
    });
    const all = batches.flat();
    await insertHealthSamplesModel(all);
    healthLog.debug({ action: 'health_sampled', projectCount: projects.length, sampleCount: all.length }, `sampled ${projects.length} project(s)`);
};

export const pruneHealthSamples = async (): Promise<void> => {
    const removed = await pruneHealthSamplesModel(Date.now() - RAW_RETENTION_MS);
    if (removed) healthLog.info({ action: 'health_pruned', removed }, `pruned ${removed} old raw health sample(s)`);
};

export const pruneHealthRollups = async (): Promise<void> => {
    const removed = await pruneHealthRollupsModel(Date.now() - ROLLUP_RETENTION_MS);
    if (removed) healthLog.info({ action: 'health_rollups_pruned', removed }, `pruned ${removed} old health rollup(s)`);
};

export const clearProjectHealth = async (projectId: string): Promise<void> => {
    await deleteHealthSamplesForProjectModel(projectId);
    await deleteHealthRollupsForProjectModel(projectId);
};

// Aggregate one project's raw samples for a set of closed hourly buckets into rollup rows. Only
// buckets that have fully elapsed (bucketStart + granularity <= now) are emitted, so the in-progress
// hour is never prematurely frozen. Idempotent: re-running recomputes and overwrites the same rows.
const buildRollupsForProject = (projectId: string, samples: ProjectHealthSample[], currentHourStart: number): ProjectHealthRollup[] => {
    // key -> aggregate, key = `${checkType}|${target}|${bucketStart}`
    const aggs = new Map<string, ProjectHealthRollup>();
    for (const s of samples) {
        const bucketStart = Math.floor(s.ts / ROLLUP_GRANULARITY_MS) * ROLLUP_GRANULARITY_MS;
        if (bucketStart >= currentHourStart) continue; // skip the in-progress hour
        const key = `${s.checkType}|${s.target}|${bucketStart}`;
        let agg = aggs.get(key);
        if (!agg) {
            agg = {
                id: `${projectId}|${s.checkType}|${s.target}|${bucketStart}`,
                projectId,
                checkType: s.checkType,
                target: s.target,
                bucketStart,
                granularityMs: ROLLUP_GRANULARITY_MS,
                total: 0,
                upSamples: 0,
                degradedSamples: 0,
                downSamples: 0,
                sumLatencyMs: 0,
                latencyCount: 0,
            };
            aggs.set(key, agg);
        }
        agg.total += 1;
        if (isUp(s.status)) agg.upSamples += 1;
        if (s.status === HealthStatus.DEGRADED) agg.degradedSamples += 1;
        if (s.status === HealthStatus.DOWN) agg.downSamples += 1;
        if (typeof s.latencyMs === 'number') {
            agg.sumLatencyMs += s.latencyMs;
            agg.latencyCount += 1;
        }
    }
    return [...aggs.values()];
};

// Leader cron entry point: roll up the last ~48h of closed hours for every project and upsert them.
// Recomputing the whole raw-retention window each run (rather than tracking a watermark) keeps this
// robust to leader restarts and out-of-order ticks.
export const rollupHealthSamples = async (): Promise<void> => {
    const projects = await getAllProjectsModel();
    if (!projects.length) return;
    const now = Date.now();
    const currentHourStart = Math.floor(now / ROLLUP_GRANULARITY_MS) * ROLLUP_GRANULARITY_MS;
    const since = now - RAW_RETENTION_MS;
    let rollupCount = 0;
    for (const p of projects) {
        try {
            const samples = await getSamplesInRangeModel(p.id, since);
            const rollups = buildRollupsForProject(p.id, samples, currentHourStart);
            await upsertHealthRollupsModel(rollups);
            rollupCount += rollups.length;
        } catch (e: any) {
            healthLog.warn({ action: 'rollup_project_failed', projectId: p.id, err: serializeError(e) }, `health rollup failed for ${p.id}`);
        }
    }
    healthLog.debug({ action: 'health_rolled_up', projectCount: projects.length, rollupCount }, `rolled up ${projects.length} project(s)`);
};

const worstStatus = (statuses: HealthStatus[]): HealthStatus => {
    if (!statuses.length) return HealthStatus.UNKNOWN;
    if (statuses.includes(HealthStatus.DOWN)) return HealthStatus.DOWN;
    if (statuses.includes(HealthStatus.DEGRADED)) return HealthStatus.DEGRADED;
    if (statuses.includes(HealthStatus.UP)) return HealthStatus.UP;
    return HealthStatus.UNKNOWN;
};

const bucketStatus = (upRatio: number, sampleCount: number): HealthStatus => {
    if (sampleCount === 0) return HealthStatus.UNKNOWN;
    if (upRatio >= 0.999) return HealthStatus.UP;
    if (upRatio >= 0.95) return HealthStatus.DEGRADED;
    return HealthStatus.DOWN;
};

const isValidWindow = (w: string): w is UptimeWindowKey => ALL_WINDOWS.includes(w as UptimeWindowKey);

// An hour's worth of observations collapsed across all of a project's targets, used for uptime and
// heatmap math. Closed hours come from rollups; the in-progress hour is synthesized from raw.
interface HourAgg {
    start: number;
    up: number;
    total: number;
}

// Build the full summary for one project: current per-check state, per-window uptime ratios, and
// heatmap buckets for the requested window. Reads are rollup-first (closed hours from the compact
// rollup table) with the current partial hour taken from raw, so no long raw history is needed.
export const getProjectHealthSummary = async (projectId: string, requestedWindow?: string): Promise<ProjectHealthSummary> => {
    const bucketWindow: UptimeWindowKey = requestedWindow && isValidWindow(requestedWindow) ? requestedWindow : '90d';
    const now = Date.now();
    const currentHourStart = Math.floor(now / ROLLUP_GRANULARITY_MS) * ROLLUP_GRANULARITY_MS;

    const latest = await getLatestSamplesForProjectModel(projectId);
    const checks: ProjectHealthCheck[] = latest
        .map((s) => ({ checkType: s.checkType, target: s.target, status: s.status, latencyMs: s.latencyMs, detail: s.detail, ts: s.ts }))
        .sort((a, b) => (a.checkType === b.checkType ? a.target.localeCompare(b.target) : a.checkType.localeCompare(b.checkType)));
    const overall = worstStatus(checks.map((c) => c.status));

    // Closed hours from rollups (summed across targets), plus the in-progress hour from raw.
    const rollups = await getRollupsInRangeModel(projectId, now - WINDOW_MS['90d']);
    const rawCurrent = await getSamplesInRangeModel(projectId, currentHourStart);

    const hourMap = new Map<number, HourAgg>();
    for (const r of rollups) {
        if (r.bucketStart >= currentHourStart) continue; // never let a stale rollup shadow the live hour
        const h = hourMap.get(r.bucketStart) ?? { start: r.bucketStart, up: 0, total: 0 };
        h.up += r.upSamples;
        h.total += r.total;
        hourMap.set(r.bucketStart, h);
    }
    let curUp = 0;
    let curTotal = 0;
    for (const s of rawCurrent) {
        if (s.ts < currentHourStart) continue;
        curTotal += 1;
        if (isUp(s.status)) curUp += 1;
    }
    if (curTotal > 0) hourMap.set(currentHourStart, { start: currentHourStart, up: curUp, total: curTotal });

    const hours = [...hourMap.values()].sort((a, b) => a.start - b.start);

    const windows: UptimeWindowSummary[] = ALL_WINDOWS.map((w) => {
        const since = now - WINDOW_MS[w];
        const inWindow = hours.filter((h) => h.start >= since);
        const up = inWindow.reduce((acc, h) => acc + h.up, 0);
        const total = inWindow.reduce((acc, h) => acc + h.total, 0);
        return { window: w, uptimeRatio: total ? up / total : 1, sampleCount: total };
    });

    const buckets = buildBuckets(hours, now, bucketWindow);

    return { projectId, overall, checks, windows, buckets, bucketWindow, generatedAt: now };
};

const buildBuckets = (hours: HourAgg[], now: number, window: UptimeWindowKey): UptimeBucket[] => {
    const bucketMs = BUCKET_MS[window];
    const windowMs = WINDOW_MS[window];
    const count = Math.ceil(windowMs / bucketMs);
    const firstStart = now - count * bucketMs;
    const buckets: UptimeBucket[] = Array.from({ length: count }, (_, i) => ({
        start: firstStart + i * bucketMs,
        end: firstStart + (i + 1) * bucketMs,
        status: HealthStatus.UNKNOWN,
        upRatio: 0,
        sampleCount: 0,
    }));
    const tallies = buckets.map(() => ({ up: 0, total: 0 }));
    for (const h of hours) {
        if (h.start < firstStart) continue;
        const idx = Math.floor((h.start - firstStart) / bucketMs);
        if (idx < 0 || idx >= count) continue;
        tallies[idx].total += h.total;
        tallies[idx].up += h.up;
    }
    for (let i = 0; i < count; i++) {
        const t = tallies[i];
        const upRatio = t.total ? t.up / t.total : 0;
        buckets[i].sampleCount = t.total;
        buckets[i].upRatio = upRatio;
        buckets[i].status = bucketStatus(upRatio, t.total);
    }
    return buckets;
};
