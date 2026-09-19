import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { AddIncidentUpdateBody, ApiKeyPermission, CreateIncidentBody, GithubScenarioConfig, ProjectEventType, ProjectWebhookType } from '@mosaiq/nsm-common/types';

// ---- API keys ----

export const useCreateApiKey = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: { name: string; permissions: ApiKeyPermission[] }) => api.post(API_ROUTES.POST_CREATE_API_KEY, { projectId }, body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectApiKeys(projectId) }),
    });
};

export const useRevokeApiKey = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (apiKeyId: string) => api.post(API_ROUTES.POST_REVOKE_API_KEY, { projectId, apiKeyId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectApiKeys(projectId) }),
    });
};

// ---- Webhooks ----

type WebhookBody = {
    name: string;
    url: string;
    events: ProjectEventType[];
    githubScenarios: GithubScenarioConfig[];
    enabled: boolean;
};

export const useCreateWebhook = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: WebhookBody) => {
            const res = await api.post(API_ROUTES.POST_CREATE_PROJECT_WEBHOOK, { projectId }, { type: ProjectWebhookType.DISCORD, ...body });
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectWebhooks(projectId) }),
    });
};

export const useUpdateWebhook = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ webhookId, body }: { webhookId: string; body: Partial<WebhookBody> }) => {
            const res = await api.post(API_ROUTES.POST_UPDATE_PROJECT_WEBHOOK, { projectId, webhookId }, body);
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectWebhooks(projectId) }),
    });
};

export const useDeleteWebhook = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (webhookId: string) => api.post(API_ROUTES.POST_DELETE_PROJECT_WEBHOOK, { projectId, webhookId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectWebhooks(projectId) }),
    });
};

export const useTestWebhook = (projectId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (webhookId: string) => api.post(API_ROUTES.POST_TEST_PROJECT_WEBHOOK, { projectId, webhookId }, {}),
    });
};

// ---- Incidents ----

export const useCreateIncident = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (payload: CreateIncidentBody) => api.post(API_ROUTES.POST_CREATE_INCIDENT, { projectId }, payload),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectIncidents(projectId) }),
    });
};

export const useAddIncidentUpdate = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ incidentId, payload }: { incidentId: string; payload: AddIncidentUpdateBody }) => api.post(API_ROUTES.POST_ADD_INCIDENT_UPDATE, { projectId, incidentId }, payload),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectIncidents(projectId) }),
    });
};

export const useDeleteIncident = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (incidentId: string) => api.post(API_ROUTES.POST_DELETE_INCIDENT, { projectId, incidentId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectIncidents(projectId) }),
    });
};
