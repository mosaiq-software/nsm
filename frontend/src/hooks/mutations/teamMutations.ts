import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability } from '@mosaiq/nsm-common/types';

export const useAddAdmin = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (login: string) => api.post(API_ROUTES.POST_ADD_ADMIN, {}, { login }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admins() }),
    });
};

export const useRemoveAdmin = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => api.post(API_ROUTES.POST_REMOVE_ADMIN, {}, { id }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admins() }),
    });
};

export const useSetTeamDefaults = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (capabilities: Capability[]) => api.post(API_ROUTES.POST_SET_TEAM_DEFAULTS, { ownerId }, { capabilities }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team(ownerId) }),
    });
};

export const useSetTeamOverride = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ memberId, memberLogin, capabilities }: { memberId: string; memberLogin: string; capabilities: Capability[] }) =>
            api.post(API_ROUTES.POST_SET_TEAM_OVERRIDE, { ownerId }, { memberId, memberLogin, capabilities }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team(ownerId) }),
    });
};

export const useDeleteTeamOverride = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (memberId: string) => api.post(API_ROUTES.POST_DELETE_TEAM_OVERRIDE, { ownerId }, { memberId }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.team(ownerId) }),
    });
};
