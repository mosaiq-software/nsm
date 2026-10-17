import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MeTeam } from '@mosaiq/nsm-common/types';
import { useMe } from '@/hooks/queries/useMe';

// Synthetic team id for the NSM admin "team" shown to admins in the switcher. It has no real owner;
// selecting it scopes the sidebar to cluster-wide admin tools (Nodes, NSM Logs, User Management).
export const NSM_TEAM_ID = '__nsm__';

export interface SelectableTeam {
    // Real GitHub ownerId, or NSM_TEAM_ID for the synthetic admin team.
    ownerId: string;
    login: string;
    isNsmAdmin: boolean;
    // The underlying MeTeam for real teams (absent for the NSM admin team).
    team?: MeTeam;
}

interface SelectedTeamContextValue {
    selectedTeamId: string | null;
    selectedTeam: SelectableTeam | null;
    selectableTeams: SelectableTeam[];
    setSelectedTeamId: (id: string) => void;
}

const SelectedTeamContext = createContext<SelectedTeamContextValue | undefined>(undefined);

const LOCAL_STORAGE_SELECTED_TEAM_KEY = 'nsm-selected-team';

const SelectedTeamProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const meCtx = useMe();
    const location = useLocation();

    const [selectedTeamId, setSelectedTeamIdState] = useState<string | null>(() => localStorage.getItem(LOCAL_STORAGE_SELECTED_TEAM_KEY));

    const setSelectedTeamId = useCallback((id: string) => {
        setSelectedTeamIdState((prev) => (prev === id ? prev : id));
        localStorage.setItem(LOCAL_STORAGE_SELECTED_TEAM_KEY, id);
    }, []);

    const selectableTeams = useMemo<SelectableTeam[]>(() => {
        const teams = meCtx.me?.teams ?? [];
        const list: SelectableTeam[] = teams.map((team) => ({ ownerId: team.ownerId, login: team.login, isNsmAdmin: false, team }));
        if (meCtx.isAdmin) {
            list.push({ ownerId: NSM_TEAM_ID, login: 'NSM Admin', isNsmAdmin: true });
        }
        return list;
    }, [meCtx.me, meCtx.isAdmin]);

    // Keep the selected team in sync with the route so deep links (and navigating into a project,
    // team, or the admin area) select the owning team in the switcher.
    useEffect(() => {
        const path = location.pathname;

        const projectMatch = path.match(/^\/p\/([^/]+)/);
        if (projectMatch) {
            const projectId = projectMatch[1];
            const team = (meCtx.me?.teams ?? []).find((t) => t.projects.some((p) => p.id === projectId));
            if (team) setSelectedTeamId(team.ownerId);
            return;
        }

        const teamMatch = path.match(/^\/teams\/([^/]+)/);
        if (teamMatch) {
            setSelectedTeamId(teamMatch[1]);
            return;
        }

        if (path.startsWith('/nodes') || path.startsWith('/logs') || path.startsWith('/users')) {
            if (meCtx.isAdmin) setSelectedTeamId(NSM_TEAM_ID);
            return;
        }
    }, [location.pathname, meCtx.me, meCtx.isAdmin, setSelectedTeamId]);

    // Default the selection to the first available team once teams load, and recover if the stored
    // selection is no longer valid (e.g. the user lost access to it).
    useEffect(() => {
        if (!meCtx.ready || selectableTeams.length === 0) return;
        const valid = selectedTeamId && selectableTeams.some((t) => t.ownerId === selectedTeamId);
        if (!valid) setSelectedTeamId(selectableTeams[0].ownerId);
    }, [meCtx.ready, selectableTeams, selectedTeamId, setSelectedTeamId]);

    const selectedTeam = useMemo(() => selectableTeams.find((t) => t.ownerId === selectedTeamId) ?? null, [selectableTeams, selectedTeamId]);

    const value = useMemo<SelectedTeamContextValue>(
        () => ({ selectedTeamId, selectedTeam, selectableTeams, setSelectedTeamId }),
        [selectedTeamId, selectedTeam, selectableTeams, setSelectedTeamId],
    );

    return <SelectedTeamContext.Provider value={value}>{children}</SelectedTeamContext.Provider>;
};

const useSelectedTeam = (): SelectedTeamContextValue => {
    const context = useContext(SelectedTeamContext);
    if (context === undefined) {
        throw new Error('useSelectedTeam must be used within a SelectedTeamProvider');
    }
    return context;
};

export { SelectedTeamProvider, useSelectedTeam };
