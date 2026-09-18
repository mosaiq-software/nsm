import { useAPI } from '@/utils/api';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability, MeResponse, MeTeam } from '@mosaiq/nsm-common/types';
import React, { createContext, useContext, useEffect, useState } from 'react';

type MeContextType = {
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

const MeContext = createContext<MeContextType | undefined>(undefined);

const MeProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const api = useAPI();
    const [me, setMe] = useState<MeResponse | null>(null);
    const [ready, setReady] = useState(false);

    const refresh = async () => {
        if (!api.token) {
            setMe(null);
            return;
        }
        const res = await api.get(API_ROUTES.GET_ME, {});
        setMe(res ?? null);
    };

    useEffect(() => {
        setReady(false);
        refresh().finally(() => setReady(true));
    }, [api.token]);

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

    return <MeContext.Provider value={{ me, ready, refresh, isAdmin, isSuperAdmin, teams, hasNoAccess, canProject, canTeam }}>{children}</MeContext.Provider>;
};

const useMe = () => {
    const context = useContext(MeContext);
    if (context === undefined) {
        throw new Error('useMe must be used within a MeProvider');
    }
    return context;
};

export { MeProvider, useMe };
