import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability, MeResponse, MeTeam } from '@mosaiq/nsm-common/types';

type UseMeResult = {
    me: MeResponse | null;
    ready: boolean;
    refresh: () => Promise<void>;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    teams: MeTeam[];
    // True when the user has no admin role and no accessible team (empty "no access" state).
    hasNoAccess: boolean;
    canProject: (projectId: string, cap: Capability) => boolean;
    canTeam: (ownerId: string, cap: Capability) => boolean;
};

// Current user's permissions/teams. Replaces MeProvider: React Query's cache shares this single
// GET_ME result across every consumer, so no context is needed.
export const useMe = (): UseMeResult => {
    const api = useAPI();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: queryKeys.me(),
        queryFn: async () => (await api.get(API_ROUTES.GET_ME, {})) ?? null,
        enabled: !!api.token,
    });

    const me = api.token ? (query.data ?? null) : null;
    // Settled once the query has resolved; with no token there is nothing to load so we are ready.
    const ready = api.token ? query.isSuccess || query.isError : true;

    const teams = me?.teams ?? [];
    const isAdmin = !!me?.isAdmin;
    const isSuperAdmin = !!me?.isSuperAdmin;
    const hasNoAccess = ready && !isAdmin && teams.length === 0;

    const canProject = (projectId: string, cap: Capability): boolean => {
        for (const team of teams) {
            const proj = team.projects.find((p) => p.id === projectId);
            if (proj) return proj.capabilities.includes(cap);
        }
        return false;
    };

    const canTeam = (ownerId: string, cap: Capability): boolean => {
        const team = teams.find((t) => t.ownerId === ownerId);
        return !!team && team.capabilities.includes(cap);
    };

    const refresh = async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    };

    return { me, ready, refresh, isAdmin, isSuperAdmin, teams, hasNoAccess, canProject, canTeam };
};
