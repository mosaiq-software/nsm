import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { NodeConfigUpdate } from '@mosaiq/nsm-common/envSchema';
import { NodeStorageSpec, PortProtocol } from '@mosaiq/nsm-common/types';

export const useSnapshotNodeStorage = (nodeId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => (await api.post(API_ROUTES.POST_NODE_STORAGE_SNAPSHOT, {}, { nodeId })) ?? null,
        onSuccess: (spec) => {
            if (spec) queryClient.setQueryData<NodeStorageSpec>(queryKeys.nodeStorage(nodeId), spec);
        },
    });
};

export const useSaveNodeConfig = (nodeId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (update: NodeConfigUpdate) => {
            const res = await api.post(API_ROUTES.POST_NODE_CONFIG, { nodeId }, update);
            if (!res?.ok) throw new Error('Request failed');
            return res;
        },
    });
};

type CreatePortReservationInput = {
    port: number;
    protocol: PortProtocol;
    projectId: string;
    envVarName: string;
    label?: string;
};

export const useCreateNodePortReservation = (nodeId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: CreatePortReservationInput) => {
            const created = await api.post(API_ROUTES.POST_NODE_PORT_RESERVATION, { nodeId }, body);
            if (!created) throw new Error('Request failed');
            return created;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.nodePortReservations(nodeId) }),
    });
};

export const useDeleteNodePortReservation = (nodeId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (reservationId: string) => {
            await api.post(API_ROUTES.POST_DELETE_NODE_PORT_RESERVATION, { nodeId, reservationId }, {});
            return reservationId;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.nodePortReservations(nodeId) }),
    });
};
