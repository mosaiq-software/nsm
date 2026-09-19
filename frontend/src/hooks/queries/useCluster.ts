import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ClusterNode, ClusterStatus, NodeHealth } from '@mosaiq/nsm-common/types';
import { useMemo } from 'react';

const NODES_POLL_MS = 10000;
const STATUS_POLL_MS = 5000;

type UseClusterResult = {
    nodes: ClusterNode[];
    status: ClusterStatus | null;
    leader: ClusterNode | null;
    healthById: Record<string, NodeHealth>;
    hasLeader: boolean;
    refresh: () => Promise<void>;
};

// Cluster nodes + control-plane status with background polling. Replaces ClusterProvider; the two
// queries are shared by key so every consumer sees the same freshly-polled data.
export const useCluster = (): UseClusterResult => {
    const api = useAPI();
    const queryClient = useQueryClient();

    const nodesQuery = useQuery({
        queryKey: queryKeys.workerNodes(),
        queryFn: async () => (await api.get(API_ROUTES.GET_WORKER_NODES, {})) ?? [],
        enabled: !!api.token,
        refetchInterval: NODES_POLL_MS,
    });

    const statusQuery = useQuery({
        queryKey: queryKeys.controlPlaneStatus(),
        queryFn: async () => (await api.get(API_ROUTES.GET_CONTROL_PLANE_STATUS, {})) ?? null,
        enabled: !!api.token,
        refetchInterval: STATUS_POLL_MS,
    });

    const nodes = nodesQuery.data ?? [];
    const status = statusQuery.data ?? null;

    const healthById = useMemo(() => {
        const map: Record<string, NodeHealth> = {};
        for (const h of status?.health ?? []) {
            map[h.nodeId] = h;
        }
        return map;
    }, [status]);

    const leader = useMemo(() => {
        if (status?.leaderId) {
            const fromStatus = (status.nodes ?? nodes).find((n) => n.nodeId === status.leaderId);
            if (fromStatus) return fromStatus;
        }
        return nodes.find((n) => n.isLeader) ?? null;
    }, [status, nodes]);

    const refresh = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.workerNodes() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.controlPlaneStatus() }),
        ]);
    };

    return { nodes, status, leader, healthById, hasLeader: Boolean(status?.leaderId ?? leader), refresh };
};
