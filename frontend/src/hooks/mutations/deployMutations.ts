import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { CdTrigger } from '@mosaiq/nsm-common/types';

// Trigger a web-initiated deploy. Modelled as a mutation even though it hits a GET endpoint: it starts
// work and returns the new deployment log id. Invalidates the project list so the new instance appears.
export const useDeployWeb = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (projectId: string) => api.get(API_ROUTES.GET_DEPLOY_WEB, { projectId }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

export const useCancelDeploy = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (projectId: string) => api.post(API_ROUTES.POST_CANCEL_DEPLOY, { projectId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

export const useTeardownProject = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (projectId: string) => api.post(API_ROUTES.POST_TEARDOWN_PROJECT, { projectId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

type SetupCicdInput = {
    projectId: string;
    branch: string;
    triggers: CdTrigger[];
    tagPattern?: string;
    cron?: string;
};

export const useSetupCicd = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ projectId, branch, triggers, tagPattern, cron }: SetupCicdInput) =>
            api.post(API_ROUTES.POST_CICD_SETUP, { projectId }, { branch, triggers, tagPattern, cron }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

export const useRemoveCicd = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (projectId: string) => api.post(API_ROUTES.POST_CICD_REMOVE, { projectId }, {}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

export const useResetDeploymentKey = (projectId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async () => api.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, { projectId }, {}),
    });
};
