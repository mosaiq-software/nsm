import crypto from 'crypto';
import {
    HealthCheckType,
    HealthStatus,
    NginxConfigLocationType,
    ProjectHealthCheck,
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
import { deleteHealthSamplesForProjectModel, getLatestSamplesForProjectModel, getSamplesInRangeModel, insertHealthSamplesModel, pruneHealthSamplesModel } from '@/persistence/projectHealthPersistence';
import { execSafe } from '@/host/exec';
import { areaLog } from '@/utils/log';

const healthLog = areaLog('health');

// How often the leader samples every project's health, and how long raw samples are retained.
export const HEALTH_SAMPLE_INTERVAL_MS = 30_000;
export const HEALTH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

// Leader cron entry point: sample every project and persist the results.
export const sampleAllProjects = async (): Promise<void> => {
    const projects = await getAllProjectsModel();
    if (!projects.length) return;
    const batches = await mapWithConcurrency(projects, 8, async (p) => {
        try {
            const nginxConfig = JSON.parse(p.nginxConfigJson || '{"servers":[]}') as ProjectNginxConfig;
            return await sampleProject(p.id, nginxConfig);
        } catch (e: any) {
            healthLog.warn({ action: 'sample_project_failed', projectId: p.id, err: e?.message }, `health sample failed for ${p.id}`);
            return [] as ProjectHealthSample[];
        }
    });
    const all = batches.flat();
    await insertHealthSamplesModel(all);
    healthLog.debug({ action: 'health_sampled', projectCount: projects.length, sampleCount: all.length }, `sampled ${projects.length} project(s)`);
};

export const pruneHealthSamples = async (): Promise<void> => {
    const removed = await pruneHealthSamplesModel(Date.now() - HEALTH_RETENTION_MS);
    if (removed) healthLog.info({ action: 'health_pruned', removed }, `pruned ${removed} old health sample(s)`);
};

export const clearProjectHealth = async (projectId: string): Promise<void> => {
    await deleteHealthSamplesForProjectModel(projectId);
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

// Build the full summary for one project: current per-check state, per-window uptime ratios, and
// heatmap buckets for the requested window. All computed from a single 90d sample fetch.
export const getProjectHealthSummary = async (projectId: string, requestedWindow?: string): Promise<ProjectHealthSummary> => {
    const bucketWindow: UptimeWindowKey = requestedWindow && isValidWindow(requestedWindow) ? requestedWindow : '90d';
    const now = Date.now();

    const latest = await getLatestSamplesForProjectModel(projectId);
    const checks: ProjectHealthCheck[] = latest
        .map((s) => ({ checkType: s.checkType, target: s.target, status: s.status, latencyMs: s.latencyMs, detail: s.detail, ts: s.ts }))
        .sort((a, b) => (a.checkType === b.checkType ? a.target.localeCompare(b.target) : a.checkType.localeCompare(b.checkType)));
    const overall = worstStatus(checks.map((c) => c.status));

    const samples = await getSamplesInRangeModel(projectId, now - WINDOW_MS['90d']);

    const windows: UptimeWindowSummary[] = ALL_WINDOWS.map((w) => {
        const since = now - WINDOW_MS[w];
        const inWindow = samples.filter((s) => s.ts >= since);
        const up = inWindow.filter((s) => isUp(s.status)).length;
        return { window: w, uptimeRatio: inWindow.length ? up / inWindow.length : 1, sampleCount: inWindow.length };
    });

    const buckets = buildBuckets(samples, now, bucketWindow);

    return { projectId, overall, checks, windows, buckets, bucketWindow, generatedAt: now };
};

const buildBuckets = (samples: ProjectHealthSample[], now: number, window: UptimeWindowKey): UptimeBucket[] => {
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
    for (const s of samples) {
        if (s.ts < firstStart) continue;
        const idx = Math.floor((s.ts - firstStart) / bucketMs);
        if (idx < 0 || idx >= count) continue;
        tallies[idx].total += 1;
        if (isUp(s.status)) tallies[idx].up += 1;
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
