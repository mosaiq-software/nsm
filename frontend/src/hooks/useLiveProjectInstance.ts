import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DeploymentState, ProjectInstance } from '@mosaiq/nsm-common/types';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';

const POLL_INTERVAL_MS = 2000;

const isLiveState = (state?: DeploymentState) => state === DeploymentState.QUEUED || state === DeploymentState.DEPLOYING;

// Fetches a single project instance and keeps it fresh: while the deployment is queued or building
// it re-polls every 2s so the build log and service states stream in; it stops once the deployment
// reaches a terminal state. Refetches from scratch whenever the selected instance id changes.
export const useLiveProjectInstance = (instanceId: string | undefined | null) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    const id = instanceId || '';

    const query = useQuery({
        queryKey: queryKeys.projectInstance(id),
        queryFn: async () => (await api.get(API_ROUTES.GET_PROJECT_INSTANCE, { projectInstanceId: id })) ?? null,
        enabled: !!api.token && !!id,
        // Poll while the deployment is in a live state; stop once it reaches a terminal state.
        refetchInterval: (q) => (isLiveState((q.state.data as ProjectInstance | null)?.state) ? POLL_INTERVAL_MS : false),
    });

    const refresh = async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectInstance(id) });
    };

    return { instance: query.data ?? null, loading: query.isFetching, refresh };
};
