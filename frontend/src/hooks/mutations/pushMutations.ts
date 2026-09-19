import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { QueryKey, queryKeys } from '@/query/keys';
import { disablePush, enablePush, sendTestNotification, setProjectNotificationEnabled } from '@/utils/push';

// Set the per-user notification preference for a project. Browser subscription provisioning (VAPID,
// PushManager) stays inside push.ts; here we just persist the preference and refresh its query.
export const useSetProjectNotification = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (enabled: boolean) => {
            if (!api.token) throw new Error('Not signed in');
            await setProjectNotificationEnabled(api.token, projectId, enabled);
            return enabled;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.pushPreference(projectId) }),
    });
};

// Same as useSetProjectNotification but takes the projectId per-call, for lists (e.g. Settings) that
// toggle many projects through one mutation instance.
export const useSetAnyProjectNotification = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ projectId, enabled }: { projectId: string; enabled: boolean }) => {
            if (!api.token) throw new Error('Not signed in');
            await setProjectNotificationEnabled(api.token, projectId, enabled);
            return { projectId, enabled };
        },
        onSuccess: ({ projectId }) => queryClient.invalidateQueries({ queryKey: queryKeys.pushPreference(projectId) }),
    });
};

// Enable push on this device (requests permission + subscribes, then registers with the leader).
// Toggling the device subscription changes the effective on/off for every project, so refresh them all.
export const useEnablePush = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            if (!api.token) throw new Error('Not signed in');
            return enablePush(api.token);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKey.PushPreference] }),
    });
};

export const useDisablePush = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            if (!api.token) throw new Error('Not signed in');
            return disablePush(api.token);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKey.PushPreference] }),
    });
};

export const useSendTestNotification = () => {
    const api = useAPI();
    return useMutation({
        mutationFn: async () => {
            if (!api.token) throw new Error('Not signed in');
            return sendTestNotification(api.token);
        },
    });
};
