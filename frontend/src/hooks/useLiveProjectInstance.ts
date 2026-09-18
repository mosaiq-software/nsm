import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DeploymentState, ProjectInstance } from '@mosaiq/nsm-common/types';
import { useCallback, useEffect, useState } from 'react';
import { useAPI } from '@/utils/api';

const POLL_INTERVAL_MS = 2000;

const isLiveState = (state?: DeploymentState) => state === DeploymentState.QUEUED || state === DeploymentState.DEPLOYING;

// Fetches a single project instance and keeps it fresh: while the deployment is queued or building
// it re-polls every 2s so the build log and service states stream in; it stops once the deployment
// reaches a terminal state. Refetches from scratch whenever the selected instance id changes.
export const useLiveProjectInstance = (instanceId: string | undefined | null) => {
    const api = useAPI();
    const [instance, setInstance] = useState<ProjectInstance | null>(null);
    const [loading, setLoading] = useState(false);

    const fetchInstance = useCallback(async () => {
        if (!instanceId) return undefined;
        const res = await api.get(API_ROUTES.GET_PROJECT_INSTANCE, { projectInstanceId: instanceId });
        if (res) setInstance(res);
        return res ?? undefined;
    }, [instanceId]); // eslint-disable-line react-hooks/exhaustive-deps

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            await fetchInstance();
        } finally {
            setLoading(false);
        }
    }, [fetchInstance]);

    useEffect(() => {
        setInstance(null);
        if (!instanceId) return;
        let cancelled = false;

        const tick = async () => {
            const res = await fetchInstance();
            if (cancelled) return;
            if (!isLiveState(res?.state)) clearInterval(intervalId);
        };

        setLoading(true);
        void tick().finally(() => {
            if (!cancelled) setLoading(false);
        });
        const intervalId = setInterval(tick, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(intervalId);
        };
    }, [instanceId, fetchInstance]);

    return { instance, loading, refresh };
};
