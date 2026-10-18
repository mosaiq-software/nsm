import { Capability } from '@mosaiq/nsm-common/types';
import { SelectableTeam } from '@/contexts/selected-team-context';

// One row in a sidebar level. `drill` marks items that navigate into a deeper level (used only for
// an affordance; the actual animation direction is derived from the level depth delta).
export interface SidebarItem {
    key: string;
    label: string;
    to: string;
    drill?: boolean;
    // Shape used for active-state matching; defaults to `to`.
    activeShape?: string;
    // When set, the item renders a live deployment status chip for this project id.
    statusProjectId?: string;
}

// A single flat screen of the sidebar. Levels form a stack from the team root (depth 0) to the
// current location; the component renders the deepest one and animates between them.
export interface SidebarLevel {
    key: string;
    depth: number;
    title: string;
    // Route to navigate to when pressing the back arrow. Absent on the root level (no back arrow).
    backTo?: string;
    items: SidebarItem[];
    // Team-root only: show the "Create Project" action for this owner login.
    createProjectOwnerLogin?: string;
    // Team-root only: route for the "Team Settings" action (present when the user can manage the team).
    teamSettingsTo?: string;
}

interface DeriveInput {
    pathname: string;
    selectedTeam: SelectableTeam | null;
    isAdmin: boolean;
    canProject: (projectId: string, cap: Capability) => boolean;
}

const projectIdFrom = (pathname: string): string | null => {
    const match = pathname.match(/^\/p\/([^/]+)/);
    return match ? match[1] : null;
};

// Build the team-root level for a regular (non-admin) team: its viewable projects, an optional
// Team Settings entry (when the current user can manage the team), and the Create Project action.
const teamRootLevel = (selectedTeam: SelectableTeam, isAdmin: boolean): SidebarLevel => {
    const team = selectedTeam.team!;
    const items: SidebarItem[] = [];

    if (team.installed) {
        for (const project of team.projects) {
            if (!project.capabilities.includes(Capability.VIEW)) continue;
            items.push({
                key: `project-${project.id}`,
                label: project.id,
                to: `/p/${project.id}`,
                drill: true,
                activeShape: `/p/${project.id}/*`,
                statusProjectId: project.id,
            });
        }
    }

    // Team management is available to NSM admins and GitHub team owners (mirrors canManageTeam on the
    // backend and the TeamDomains/TeamDetail checks on the frontend).
    const canManage = isAdmin || team.isOwner;

    return {
        key: `team-root-${team.ownerId}`,
        depth: 0,
        title: 'Projects',
        items,
        createProjectOwnerLogin: team.installed && team.capabilities.includes(Capability.CREATE_PROJECT) ? team.login : undefined,
        teamSettingsTo: canManage ? `/teams/${team.ownerId}` : undefined,
    };
};

// The NSM admin "team" root: cluster-wide admin tools.
const nsmRootLevel = (): SidebarLevel => ({
    key: 'nsm-root',
    depth: 0,
    title: 'NSM Admin',
    items: [
        { key: 'nodes', label: 'Nodes', to: '/nodes', activeShape: '/nodes/*' },
        { key: 'nsm-logs', label: 'NSM Logs', to: '/logs' },
        { key: 'users', label: 'User Management', to: '/users' },
    ],
});

const projectLevel = (projectId: string, canProject: DeriveInput['canProject']): SidebarLevel => {
    const items: SidebarItem[] = [{ key: 'dashboard', label: 'Dashboard', to: `/p/${projectId}` }];
    if (canProject(projectId, Capability.CONFIGURE)) {
        items.push({ key: 'config', label: 'Config', to: `/p/${projectId}/config`, drill: true, activeShape: `/p/${projectId}/config/*` });
    }
    if (canProject(projectId, Capability.DEPLOY)) {
        items.push({ key: 'deploy', label: 'Deploy', to: `/p/${projectId}/deploy` });
    }
    items.push({ key: 'monitoring', label: 'Monitoring', to: `/p/${projectId}/monitoring`, drill: true, activeShape: `/p/${projectId}/monitoring/*` });
    return { key: `project-${projectId}`, depth: 1, title: projectId, backTo: '/', items };
};

const configLevel = (projectId: string): SidebarLevel => ({
    key: `config-${projectId}`,
    depth: 2,
    title: 'Config',
    backTo: `/p/${projectId}`,
    items: [
        { key: 'config-project', label: 'Project', to: `/p/${projectId}/config/project` },
        { key: 'config-routing', label: 'Routing', to: `/p/${projectId}/config/routing` },
        { key: 'config-system', label: 'System', to: `/p/${projectId}/config/system` },
        { key: 'config-resources', label: 'Resources', to: `/p/${projectId}/config/resources` },
        { key: 'config-keys', label: 'Keys', to: `/p/${projectId}/config/keys` },
        { key: 'config-webhooks', label: 'Webhooks', to: `/p/${projectId}/config/webhooks` },
        { key: 'config-cd', label: 'CD', to: `/p/${projectId}/config/cd` },
    ],
});

const monitoringLevel = (projectId: string, canProject: DeriveInput['canProject']): SidebarLevel => {
    const items: SidebarItem[] = [];
    if (canProject(projectId, Capability.DEPLOY)) {
        items.push({ key: 'monitoring-logs', label: 'Logs', to: `/p/${projectId}/monitoring/logs` });
        items.push({ key: 'monitoring-metrics', label: 'Metrics', to: `/p/${projectId}/monitoring/metrics` });
    }
    if (canProject(projectId, Capability.CONFIGURE)) {
        items.push({ key: 'monitoring-files', label: 'Files', to: `/p/${projectId}/monitoring/files` });
    }
    items.push({ key: 'monitoring-status', label: 'Status', to: `/p/${projectId}/monitoring/status` });
    items.push({ key: 'monitoring-incidents', label: 'Incidents', to: `/p/${projectId}/monitoring/incidents` });
    return { key: `monitoring-${projectId}`, depth: 2, title: 'Monitoring', backTo: `/p/${projectId}`, items };
};

const teamSettingsLevel = (ownerId: string): SidebarLevel => ({
    key: `team-settings-${ownerId}`,
    depth: 1,
    title: 'Team Settings',
    backTo: '/',
    items: [
        { key: 'team-settings-team', label: 'Team', to: `/teams/${ownerId}` },
        { key: 'team-settings-domains', label: 'Domains', to: `/teams/${ownerId}/domains`, activeShape: `/teams/${ownerId}/domains/*` },
    ],
});

// Derive the full level stack (root -> current) from the location, selected team, and capabilities.
// The sidebar renders the deepest level and animates when the stack depth changes.
export const deriveSidebarStack = ({ pathname, selectedTeam, isAdmin, canProject }: DeriveInput): SidebarLevel[] => {
    if (!selectedTeam) return [];

    if (selectedTeam.isNsmAdmin) {
        return [nsmRootLevel()];
    }

    const stack: SidebarLevel[] = [teamRootLevel(selectedTeam, isAdmin)];

    const projectId = projectIdFrom(pathname);
    if (projectId) {
        stack.push(projectLevel(projectId, canProject));
        if (pathname.startsWith(`/p/${projectId}/config`)) {
            stack.push(configLevel(projectId));
        } else if (pathname.startsWith(`/p/${projectId}/monitoring`)) {
            stack.push(monitoringLevel(projectId, canProject));
        }
        return stack;
    }

    const teamMatch = pathname.match(/^\/teams\/([^/]+)/);
    if (teamMatch) {
        stack.push(teamSettingsLevel(teamMatch[1]));
    }

    return stack;
};
