import { ALL_CAPABILITIES, Capability, MeResponse, MeTeam, ORPHAN_TEAM_ID, Project, Team, TeamConfig, TeamDetail, TeamMember, TeamType, User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { getAllTeamConfigsModel, getTeamConfigModel } from '@/persistence/teamConfigPersistence';
import { getTeamOverridesForOwnerModel } from '@/persistence/teamOverridePersistence';
import { getAllProjects } from './projectController';
import {
    canManageTeam,
    getEffectiveCapabilitiesForTeam,
    getInstalledOwners,
    isAdminUser,
    isSuperAdmin,
    isTeamOwner,
    listOrgMembersForTeam,
    listOrgOwnersForTeam,
    orphanTeam,
    resolveTeamById,
    resolveTeamByLogin,
} from './authz';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const teamLog = areaLog('team');

const mapGithubType = (t: string): TeamType => (t.toLowerCase() === 'organization' ? TeamType.ORGANIZATION : TeamType.USER);

// Every team NSM knows about: installed owners (source of truth for existence) merged with any
// stored config (so configured-but-uninstalled teams still surface, flagged installed:false).
const buildAllTeams = async (): Promise<Map<string, Team>> => {
    const teams = new Map<string, Team>();
    const owners = await getInstalledOwners();
    const configs = await getAllTeamConfigsModel();
    const configById = new Map(configs.map((c) => [c.ownerId, c] as const));
    for (const o of owners) {
        teams.set(o.id, { ownerId: o.id, login: o.login, type: mapGithubType(o.type), installed: true, defaultCapabilities: configById.get(o.id)?.defaultCapabilities ?? [] });
    }
    for (const c of configs) {
        if (!teams.has(c.ownerId)) teams.set(c.ownerId, { ownerId: c.ownerId, login: c.login, type: c.type, installed: false, defaultCapabilities: c.defaultCapabilities });
    }
    return teams;
};

// Admin-only listing for the Teams management page.
export const listAllTeams = async (): Promise<Team[]> => {
    const teams = await buildAllTeams();
    return [...teams.values()].sort((a, b) => Number(b.installed) - Number(a.installed) || a.login.localeCompare(b.login));
};

// Group all projects by their resolved team owner id; projects with no resolvable team are orphaned.
const groupProjectsByTeam = async (projects: Project[]): Promise<{ byTeam: Map<string, Project[]>; orphans: Project[] }> => {
    const byTeam = new Map<string, Project[]>();
    const orphans: Project[] = [];
    for (const p of projects) {
        const team = await resolveTeamByLogin(p.repoOwner);
        if (!team) {
            orphans.push(p);
            continue;
        }
        const list = byTeam.get(team.ownerId) ?? [];
        list.push(p);
        byTeam.set(team.ownerId, list);
    }
    return { byTeam, orphans };
};

// The permission-aware view of everything the signed-in user can see, driving the sidebar.
export const buildMeResponse = async (user: User): Promise<MeResponse> => {
    const admin = await isAdminUser(user);
    const superAdmin = isSuperAdmin(user);
    const projects = await getAllProjects();
    const { byTeam, orphans } = await groupProjectsByTeam(projects);
    const teams = await buildAllTeams();

    const meTeams: MeTeam[] = [];
    for (const team of teams.values()) {
        const caps = await getEffectiveCapabilitiesForTeam(user, team);
        // Regular users only see teams they have access to; admins additionally see every team
        // (including uninstalled ones, so they get the install warning) even with empty caps.
        if (!admin && caps.length === 0) continue;
        const owner = await isTeamOwner(user, team);
        const teamProjects = (byTeam.get(team.ownerId) ?? []).map((p) => ({ id: p.id, capabilities: caps }));
        meTeams.push({ ownerId: team.ownerId, login: team.login, type: team.type, installed: team.installed, isOwner: owner, capabilities: caps, projects: teamProjects });
    }

    // Orphan/legacy projects (owner not installed, no config) are surfaced to the super admin only.
    if (superAdmin && orphans.length > 0) {
        const ot = orphanTeam();
        meTeams.push({ ownerId: ot.ownerId, login: ot.login, type: ot.type, installed: false, isOwner: false, capabilities: [], projects: orphans.map((p) => ({ id: p.id, capabilities: [] })) });
    }

    meTeams.sort((a, b) => Number(b.installed) - Number(a.installed) || a.login.localeCompare(b.login));
    return { user, isSuperAdmin: superAdmin, isAdmin: admin, teams: meTeams };
};

// Env var values are only exposed to users who can CONFIGURE; VIEW/DEPLOY-only users get names +
// placeholders with blanked values so secrets never reach the client for a project they can't edit.
export const redactProjectSecrets = (project: Project, canConfigure: boolean): Project =>
    canConfigure ? project : { ...project, secrets: project.secrets?.map((s) => ({ ...s, secretValue: s.variable ? s.secretValue : '' })) };

// Projects the user is allowed to view, for GET /projects (secrets redacted unless they can configure).
export const getVisibleProjects = async (user: User): Promise<Project[]> => {
    const projects = await getAllProjects();
    const visible: Project[] = [];
    for (const p of projects) {
        const team = await resolveTeamByLogin(p.repoOwner);
        if (!team) continue;
        const caps = await getEffectiveCapabilitiesForTeam(user, team);
        if (caps.includes(Capability.VIEW)) visible.push(redactProjectSecrets(p, caps.includes(Capability.CONFIGURE)));
    }
    return visible;
};

// Team detail with the dynamic member list for the editor. Members are only enumerable when the App
// is installed; an uninstalled team returns an empty member list (the UI shows the install warning).
export const getTeamDetail = async (user: User, ownerId: string): Promise<TeamDetail | null> => {
    const team = await resolveTeamById(ownerId);
    if (!team) return null;
    const canManage = await canManageTeam(user, team);
    const members: TeamMember[] = [];
    if (team.installed && team.type === TeamType.ORGANIZATION) {
        const ghMembers = await listOrgMembersForTeam(team.login);
        const owners = await listOrgOwnersForTeam(team.login);
        const ownerLogins = new Set(owners.map((o) => o.login.toLowerCase()));
        const overrides = await getTeamOverridesForOwnerModel(team.ownerId);
        const overrideById = new Map(overrides.map((o) => [o.memberId, o] as const));
        for (const m of ghMembers) {
            const owner = ownerLogins.has(m.login.toLowerCase());
            const override = overrideById.get(m.id) ?? null;
            let effective: Capability[];
            if (owner) {
                effective = [...ALL_CAPABILITIES];
            } else {
                const caps = new Set<Capability>(team.defaultCapabilities);
                if (override) for (const c of override.capabilities) caps.add(c);
                if (caps.size > 0) caps.add(Capability.VIEW);
                effective = [...caps];
            }
            members.push({ id: m.id, login: m.login, avatarUrl: m.avatarUrl, isOwner: owner, override: override ? override.capabilities : null, effective });
        }
    } else if (team.installed && team.type === TeamType.USER) {
        members.push({ id: '', login: team.login, avatarUrl: '', isOwner: true, override: null, effective: [...ALL_CAPABILITIES] });
    }
    return { team, members, canManage };
};

export const setTeamDefaults = async (ownerId: string, capabilities: Capability[]): Promise<void> => {
    const team = await resolveTeamById(ownerId);
    if (!team || !team.installed) throw new Error('Team is not installed');
    const config: TeamConfig = { ownerId: team.ownerId, login: team.login, type: team.type, defaultCapabilities: dedupeCaps(capabilities) };
    await cluster.propose({ type: OpType.UPSERT_TEAM_CONFIG, config });
    teamLog.info({ action: 'team_defaults_set', ownerId, login: team.login, capabilities: config.defaultCapabilities }, `set default capabilities for ${team.login}`);
};

export const setTeamOverride = async (ownerId: string, memberId: string, memberLogin: string, capabilities: Capability[]): Promise<void> => {
    const team = await resolveTeamById(ownerId);
    if (!team || !team.installed) throw new Error('Team is not installed');
    // Ensure the team config row exists so its default is persisted alongside overrides.
    if (!(await getTeamConfigModel(team.ownerId))) {
        await cluster.propose({ type: OpType.UPSERT_TEAM_CONFIG, config: { ownerId: team.ownerId, login: team.login, type: team.type, defaultCapabilities: team.defaultCapabilities } });
    }
    await cluster.propose({ type: OpType.UPSERT_TEAM_OVERRIDE, override: { ownerId: team.ownerId, memberId, memberLogin, capabilities: dedupeCaps(capabilities) } });
    teamLog.info({ action: 'team_override_set', ownerId, memberLogin, capabilities }, `set override for ${memberLogin} in ${team.login}`);
};

export const clearTeamOverride = async (ownerId: string, memberId: string): Promise<void> => {
    const team = await resolveTeamById(ownerId);
    if (!team) throw new Error('Team not found');
    await cluster.propose({ type: OpType.DELETE_TEAM_OVERRIDE, ownerId: team.ownerId, memberId });
    teamLog.info({ action: 'team_override_cleared', ownerId, memberId }, `cleared override in ${team.login}`);
};

const dedupeCaps = (caps: Capability[]): Capability[] => [...new Set(caps.filter((c) => ALL_CAPABILITIES.includes(c)))];
