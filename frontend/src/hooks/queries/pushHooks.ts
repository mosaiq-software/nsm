import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { getProjectNotificationEnabled, isPushSupported } from '@/utils/push';

// Server-side per-user notification preference (opt-out) for a project. Does not reflect whether this
// browser has an active push subscription — callers combine it with isPushSubscribed() for that.
export const usePushPreference = (projectId: string, enabled = true) => {
    const api = useAPI();
    const token = api.token;
    return useQuery({
        queryKey: queryKeys.pushPreference(projectId),
        queryFn: async () => (token ? getProjectNotificationEnabled(token, projectId) : false),
        enabled: !!token && !!projectId && isPushSupported() && enabled,
    });
};
