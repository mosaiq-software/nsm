import { useAPI } from '@/utils/api';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ClusterNode, ClusterStatus, NodeHealth } from '@mosaiq/nsm-common/types';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

type ClusterContextType = {
    nodes: ClusterNode[];
    status: ClusterStatus | null;
    leader: ClusterNode | null;
    healthById: Record<string, NodeHealth>;
    hasLeader: boolean;
    refresh: () => Promise<void>;
};

const NODES_POLL_MS = 10000;
const STATUS_POLL_MS = 5000;

const ClusterContext = createContext<ClusterContextType | undefined>(undefined);

const ClusterProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const api = useAPI();
    const [nodes, setNodes] = useState<ClusterNode[]>([]);
    const [status, setStatus] = useState<ClusterStatus | null>(null);
    const tokenRef = useRef<string | undefined>(api.token);
    tokenRef.current = api.token;

    const fetchNodes = async () => {
        const response = await api.get(API_ROUTES.GET_WORKER_NODES, {});
        if (response) {
            setNodes(response);
        }
    };

    const fetchStatus = async () => {
        const response = await api.get(API_ROUTES.GET_CONTROL_PLANE_STATUS, {});
        if (response) {
            setStatus(response);
        }
    };

    const refresh = async () => {
        await Promise.all([fetchNodes(), fetchStatus()]);
    };

    useEffect(() => {
        if (!api.token) {
            setNodes([]);
            setStatus(null);
            return;
        }
        refresh();
        const nodesInterval = setInterval(() => {
            if (tokenRef.current) fetchNodes();
        }, NODES_POLL_MS);
        const statusInterval = setInterval(() => {
            if (tokenRef.current) fetchStatus();
        }, STATUS_POLL_MS);
        return () => {
            clearInterval(nodesInterval);
            clearInterval(statusInterval);
        };
    }, [api.token]);

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

    return (
        <ClusterContext.Provider
            value={{
                nodes,
                status,
                leader,
                healthById,
                hasLeader: Boolean(status?.leaderId ?? leader),
                refresh,
            }}
        >
            {children}
        </ClusterContext.Provider>
    );
};

const useCluster = () => {
    const context = useContext(ClusterContext);
    if (context === undefined) {
        throw new Error('useCluster must be used within a ClusterProvider');
    }
    return context;
};

export { ClusterProvider, useCluster };
