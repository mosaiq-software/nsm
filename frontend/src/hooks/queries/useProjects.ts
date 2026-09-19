import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { deriveProjectState } from '@/utils/projectStatus';

const STATUS_POLL_MS = 5000;

const deriveStatusMap = (projects: Project[]): Record<string, DeploymentState> => {
    const map: Record<string, DeploymentState> = {};
    for (const project of projects) map[project.id] = deriveProjectState(project);
    return map;
};

// Editable list of projects. This query is NOT polled: optimistic/client-only config edits patch its
// cache via queryClient.setQueryData (see project mutation hooks), and a background poll would clobber
// those unsaved edits. Live status chips use useProjectStatuses instead.
export const useProjects = () => {
    const api = useAPI();
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: queryKeys.projects(),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECTS, {})) ?? [],
        enabled: !!api.token,
    });

    const refresh = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.projectStatuses() }),
        ]);
    };

    return {
        projects: query.data ?? [],
        isLoading: query.isLoading,
        refresh,
    };
};

// Derived status map, polled every 5s on its own cache key so it never overwrites the editable
// `projects` list. Consumers read statusById[projectId].
export const useProjectStatuses = (): Record<string, DeploymentState> => {
    const api = useAPI();

    const query = useQuery({
        queryKey: queryKeys.projectStatuses(),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECTS, {})) ?? [],
        enabled: !!api.token,
        refetchInterval: STATUS_POLL_MS,
        select: deriveStatusMap,
    });

    return query.data ?? {};
};
