import { Project, ProjectResourceQuota } from '@mosaiq/nsm-common/types';
import { getAllProjects, getProject, proposeProjectUpsert } from './projectController';
import { getProjectResourceUsage } from './observabilityController';
import { QuotaBreachInfo, sendQuotaBreachNotification } from './pushController';
import { clearQuotaBreachStateModel, getQuotaBreachStateModel, setQuotaBreachStateModel } from '@/persistence/quotaBreachPersistence';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const quotaLog = areaLog('quota');

// Re-notify at most once per 24h while a project stays over an allocation.
const RENOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Reject NaN/Infinity/negative values; allow undefined (that resource is uncapped). A cleaned quota
// with all fields undefined is treated as "no allocation".
const sanitizeQuotaField = (v: number | undefined, label: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`invalid ${label}: must be a non-negative number`);
    }
    return v;
};

const sanitizeQuota = (quota: ProjectResourceQuota): ProjectResourceQuota | undefined => {
    const cleaned: ProjectResourceQuota = {
        cpuCores: sanitizeQuotaField(quota?.cpuCores, 'cpuCores'),
        memoryBytes: sanitizeQuotaField(quota?.memoryBytes, 'memoryBytes'),
        storageBytes: sanitizeQuotaField(quota?.storageBytes, 'storageBytes'),
    };
    const hasAny = cleaned.cpuCores !== undefined || cleaned.memoryBytes !== undefined || cleaned.storageBytes !== undefined;
    return hasAny ? cleaned : undefined;
};

// Set (or clear) a project's advisory resource allocation. Admin-only path; this is the sole writer
// of resourceQuota (the generic project update route strips it).
export const setProjectQuota = async (projectId: string, quota: ProjectResourceQuota): Promise<void> => {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');
    const cleaned = sanitizeQuota(quota);
    const merged: Project = { ...project, id: projectId, resourceQuota: cleaned };
    delete (merged as any).instances;
    await proposeProjectUpsert(merged);
    quotaLog.info({ action: 'quota_set', projectId, quota: cleaned }, `resource allocation updated for ${projectId}`);
};

// The set of resource keys a project is currently over allocation on.
const computeBreaches = (quota: ProjectResourceQuota, usage: { cpuCores: number; memoryBytes: number; storageBytes: number }): QuotaBreachInfo[] => {
    const breaches: QuotaBreachInfo[] = [];
    if (quota.cpuCores !== undefined && usage.cpuCores > quota.cpuCores) breaches.push({ resource: 'cpu', usage: usage.cpuCores, limit: quota.cpuCores });
    if (quota.memoryBytes !== undefined && usage.memoryBytes > quota.memoryBytes) breaches.push({ resource: 'memory', usage: usage.memoryBytes, limit: quota.memoryBytes });
    if (quota.storageBytes !== undefined && usage.storageBytes > quota.storageBytes) breaches.push({ resource: 'storage', usage: usage.storageBytes, limit: quota.storageBytes });
    return breaches;
};

// Leader-only sweep comparing every allocated project's live usage to its allocation. Notifies when
// a newly-breached resource appears OR at least 24h have passed since the last notification while
// still over. Clears state (no recovery notice) when a project is back within all allocations.
export const checkAllQuotas = async (): Promise<void> => {
    if (!cluster.isLeader()) return;
    try {
        const projects = await getAllProjects();
        for (const project of projects) {
            const quota = project.resourceQuota;
            if (!quota) {
                // Drop any stale breach state for a project whose allocation was removed.
                await clearQuotaBreachStateModel(project.id).catch(() => {});
                continue;
            }
            try {
                const usage = await getProjectResourceUsage(project.id);
                const breaches = computeBreaches(quota, usage);
                const prior = await getQuotaBreachStateModel(project.id);

                if (breaches.length === 0) {
                    if (prior) await clearQuotaBreachStateModel(project.id);
                    continue;
                }

                const breachedResources = breaches.map((b) => b.resource).sort();
                const priorResources = new Set(prior?.resources ?? []);
                const hasNewResource = breachedResources.some((r) => !priorResources.has(r));
                const cooldownElapsed = prior ? Date.now() - prior.lastNotifiedAt >= RENOTIFY_COOLDOWN_MS : true;

                if (hasNewResource || cooldownElapsed) {
                    await sendQuotaBreachNotification(project, breaches);
                    await setQuotaBreachStateModel(project.id, breachedResources, Date.now());
                    quotaLog.info({ action: 'quota_breach_notified', projectId: project.id, resources: breachedResources, reason: hasNewResource ? 'new_resource' : 'cooldown' }, `notified quota breach for ${project.id}`);
                } else {
                    // Still over the same resources and within cooldown: keep the resource set current
                    // (in case one resource recovered) without resetting the notification timer.
                    await setQuotaBreachStateModel(project.id, breachedResources, prior?.lastNotifiedAt ?? Date.now());
                }
            } catch (e: any) {
                quotaLog.warn({ action: 'quota_check_failed', projectId: project.id, err: e?.message || String(e) }, `failed to check quota for ${project.id}`);
            }
        }
    } catch (e: any) {
        quotaLog.error({ action: 'quota_sweep_failed', err: e?.message || String(e) }, 'failed to run quota sweep');
    }
};
