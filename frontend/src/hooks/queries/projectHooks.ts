import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { LogSelector } from '@mosaiq/nsm-common/types';

const RESOURCE_POLL_MS = 15000;
const METRICS_POLL_MS = 15000;

export const useProjectApiKeys = (projectId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectApiKeys(projectId),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_API_KEYS, { projectId })) ?? [],
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectWebhooks = (projectId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectWebhooks(projectId),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_WEBHOOKS, { projectId })) ?? [],
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectDomains = (projectId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectDomains(projectId),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_DOMAINS, { projectId })) ?? [],
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectIncidents = (projectId: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectIncidents(projectId),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_INCIDENTS, { projectId })) ?? [],
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectPortReservations = (projectId: string | undefined) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectPortReservations(projectId ?? ''),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_PORT_RESERVATIONS, { projectId: projectId as string })) ?? [],
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectDeployAverage = (projectId: string | undefined, refreshKey?: unknown) => {
    const api = useAPI();
    return useQuery({
        queryKey: [...queryKeys.projectDeployAverage(projectId ?? ''), refreshKey] as const,
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_DEPLOY_AVERAGE, { projectId: projectId as string })) ?? null,
        enabled: !!api.token && !!projectId,
    });
};

export const useProjectInstance = (instanceId: string | undefined | null) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectInstance(instanceId ?? ''),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_INSTANCE, { projectInstanceId: instanceId as string })) ?? null,
        enabled: !!api.token && !!instanceId,
    });
};

export const useProjectResourceUsage = (projectId: string | undefined) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectResourceUsage(projectId ?? ''),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_RESOURCE_USAGE, { projectId: projectId as string })) ?? null,
        enabled: !!api.token && !!projectId,
        refetchInterval: RESOURCE_POLL_MS,
    });
};

// Time-series metrics for a project/instance/service scope. The selector is serialized into the key
// so switching scope/metric/range fetches (and caches) independently; polled every 15s.
export const useObservabilityMetrics = (selector: LogSelector, metric: string, rangeMs: number, enabled = true) => {
    const api = useAPI();
    const selectorKey = JSON.stringify({ ...selector, metric });
    return useQuery({
        queryKey: queryKeys.observabilityMetrics(selectorKey, metric, String(rangeMs)),
        queryFn: async () => {
            const now = Date.now();
            const start = `${Math.floor((now - rangeMs) / 1000)}`;
            const end = `${Math.floor(now / 1000)}`;
            return (await api.get(API_ROUTES.GET_OBSERVABILITY_METRICS, {}, { ...selector, metric, start, end, step: '30s' })) ?? { metric, series: [] };
        },
        enabled: !!api.token && enabled,
        refetchInterval: METRICS_POLL_MS,
    });
};

export const useProjectHealth = (projectId: string | undefined, windowKey: string) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.projectHealth(projectId ?? '', windowKey),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_HEALTH, { projectId: projectId as string }, { window: windowKey })) ?? null,
        enabled: !!api.token && !!projectId,
        refetchInterval: 30000,
    });
};
