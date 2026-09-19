import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';

export const useTeams = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teams(),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAMS, {})) ?? [],
        enabled: !!api.token && enabled,
    });
};

export const useTeam = (ownerId: string | undefined) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.team(ownerId ?? ''),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM, { ownerId: ownerId as string })) ?? null,
        enabled: !!api.token && !!ownerId,
    });
};

export const useAdmins = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.admins(),
        queryFn: async () => (await api.get(API_ROUTES.GET_ADMINS, {})) ?? null,
        enabled: !!api.token && enabled,
    });
};
