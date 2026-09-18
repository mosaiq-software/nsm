import express from 'express';
import { ALL_CAPABILITIES, Capability, ORPHAN_TEAM_ID, Team, TeamType, User } from '@mosaiq/nsm-common/types';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { getAdminByLoginModel } from '@/persistence/adminPersistence';
import { getTeamConfigByLoginModel, getTeamConfigModel } from '@/persistence/teamConfigPersistence';
import { getTeamOverrideModel } from '@/persistence/teamOverridePersistence';
import { getProjectByIdModel } from '@/persistence/projectPersistence';
import { GithubMember, GithubOwner, listInstallationOwners, listOrgMembers, listOrgOwners } from '@/utils/githubApp';
import { isGithubAppConfigured } from '@/config';
import { areaLog } from '@/utils/log';

const authzLog = areaLog('authz');

// Small stale-tolerant TTL cache. On a fetch error we serve the last successful value (even if
// expired) so a transient GitHub outage or rate-limit never blocks a permission check. Only when
// there is no prior value does the error propagate to the caller.
const CACHE_TTL_MS = 60_000;
interface CacheEntry<V> {
    value: V;
    fetchedAt: number;
}
const makeCache = <V>(fetcher: (key: string) => Promise<V>) => {
    const store = new Map<string, CacheEntry<V>>();
    const inflight = new Map<string, Promise<V>>();
    return async (key: string): Promise<V> => {
        const entry = store.get(key);
        if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry.value;
        const existing = inflight.get(key);
        if (existing) return existing;
        const p = (async () => {
            try {
                const value = await fetcher(key);
                store.set(key, { value, fetchedAt: Date.now() });
                return value;
            } catch (e: any) {
                if (entry) {
                    authzLog.warn({ action: 'cache_stale_served', key, err: e?.message }, `serving stale cache for ${key} after fetch error`);
                    return entry.value;
                }
                throw e;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, p);
        return p;
    };
};

const installedOwnersCache = makeCache<GithubOwner[]>(async () => listInstallationOwners());
const orgMembersCache = makeCache<GithubMember[]>(async (org) => listOrgMembers(org));
const orgOwnersCache = makeCache<GithubMember[]>(async (org) => listOrgOwners(org));

const mapGithubType = (t: string): TeamType => (t.toLowerCase() === 'organization' ? TeamType.ORGANIZATION : TeamType.USER);

// The owners (users/orgs) that currently have the App installed. Empty when the App is unconfigured.
export const getInstalledOwners = async (): Promise<GithubOwner[]> => {
    if (!isGithubAppConfigured()) return [];
    try {
        return await installedOwnersCache('all');
    } catch (e: any) {
        authzLog.warn({ action: 'installed_owners_failed', err: e?.message }, 'failed to list installed owners');
        return [];
    }
};

const getOrgMembers = async (org: string): Promise<GithubMember[]> => {
    if (!isGithubAppConfigured()) return [];
    try {
        return await orgMembersCache(org.toLowerCase());
    } catch (e: any) {
        authzLog.warn({ action: 'org_members_failed', org, err: e?.message }, `failed to list members for ${org}`);
        return [];
    }
};

const getOrgOwners = async (org: string): Promise<GithubMember[]> => {
    if (!isGithubAppConfigured()) return [];
    try {
        return await orgOwnersCache(org.toLowerCase());
    } catch (e: any) {
        authzLog.warn({ action: 'org_owners_failed', org, err: e?.message }, `failed to list owners for ${org}`);
        return [];
    }
};

export const listOrgMembersForTeam = getOrgMembers;
export const listOrgOwnersForTeam = getOrgOwners;

export const orphanTeam = (): Team => ({ ownerId: ORPHAN_TEAM_ID, login: '(unassigned)', type: TeamType.ORGANIZATION, installed: false, defaultCapabilities: [] });

// Resolve a team by owner login: installed installations take precedence (and merge stored config),
// otherwise a stored-but-uninstalled config surfaces as installed:false. Returns null if neither.
export const resolveTeamByLogin = async (login: string): Promise<Team | null> => {
    const owners = await getInstalledOwners();
    const inst = owners.find((o) => o.login.toLowerCase() === login.toLowerCase());
    if (inst) {
        const cfg = await getTeamConfigModel(inst.id);
        return { ownerId: inst.id, login: inst.login, type: mapGithubType(inst.type), installed: true, defaultCapabilities: cfg?.defaultCapabilities ?? [] };
    }
    const cfg = await getTeamConfigByLoginModel(login);
    if (cfg) return { ownerId: cfg.ownerId, login: cfg.login, type: cfg.type, installed: false, defaultCapabilities: cfg.defaultCapabilities };
    return null;
};

// Resolve a team by owner account id (used by team-management routes addressed by ownerId).
export const resolveTeamById = async (ownerId: string): Promise<Team | null> => {
    if (ownerId === ORPHAN_TEAM_ID) return orphanTeam();
    const owners = await getInstalledOwners();
    const inst = owners.find((o) => o.id === ownerId);
    const cfg = await getTeamConfigModel(ownerId);
    if (inst) return { ownerId: inst.id, login: inst.login, type: mapGithubType(inst.type), installed: true, defaultCapabilities: cfg?.defaultCapabilities ?? [] };
    if (cfg) return { ownerId: cfg.ownerId, login: cfg.login, type: cfg.type, installed: false, defaultCapabilities: cfg.defaultCapabilities };
    return null;
};

export const resolveTeamForProject = async (project: { repoOwner: string }): Promise<Team> => {
    const team = await resolveTeamByLogin(project.repoOwner);
    return team ?? orphanTeam();
};

export const isSuperAdmin = (user: { name: string }): boolean => {
    const su = process.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
    return !!su && su.toLowerCase() === user.name.toLowerCase();
};

export const isAdminUser = async (user: { name: string }): Promise<boolean> => {
    if (isSuperAdmin(user)) return true;
    const admin = await getAdminByLoginModel(user.name);
    return !!admin;
};

// Whether the user is an owner (GitHub admin) of the team - absolute permissions within it.
export const isTeamOwner = async (user: { name: string }, team: Team): Promise<boolean> => {
    if (!team.installed) return false;
    if (team.type === TeamType.USER) return team.login.toLowerCase() === user.name.toLowerCase();
    const owners = await getOrgOwners(team.login);
    return owners.some((o) => o.login.toLowerCase() === user.name.toLowerCase());
};

// Whether the user may edit a team's defaults/overrides: NSM admins or the team's own GitHub owner.
export const canManageTeam = async (user: User, team: Team): Promise<boolean> => (await isAdminUser(user)) || (await isTeamOwner(user, team));

// Whether the App is currently installed on an owner (used to gate deploys and project actions).
export const isOwnerInstalled = async (login: string): Promise<boolean> => (await getInstalledOwners()).some((o) => o.login.toLowerCase() === login.toLowerCase());

// Effective capabilities for a user within a team: admins/owners get everything; otherwise the team
// default unioned (max) with the member's additive override, gated on current GitHub membership.
// Uninstalled and orphan teams are inaccessible for EVERYONE (membership can't be verified) - they
// are only surfaced as listings with an install warning, never granted capabilities.
export const getEffectiveCapabilitiesForTeam = async (user: User, team: Team): Promise<Capability[]> => {
    if (team.ownerId === ORPHAN_TEAM_ID) return [];
    if (!team.installed) return [];
    if (await isAdminUser(user)) return [...ALL_CAPABILITIES];
    if (team.type === TeamType.USER) {
        return team.login.toLowerCase() === user.name.toLowerCase() ? [...ALL_CAPABILITIES] : [];
    }
    const members = await getOrgMembers(team.login);
    const isMember = members.some((m) => m.login.toLowerCase() === user.name.toLowerCase());
    if (!isMember) return [];
    const owners = await getOrgOwners(team.login);
    if (owners.some((o) => o.login.toLowerCase() === user.name.toLowerCase())) return [...ALL_CAPABILITIES];
    const caps = new Set<Capability>(team.defaultCapabilities);
    const override = await getTeamOverrideModel(team.ownerId, user.githubId);
    if (override) for (const c of override.capabilities) caps.add(c);
    if (caps.size > 0) caps.add(Capability.VIEW);
    return [...caps];
};

export const getEffectiveCapabilitiesForProject = async (user: User, project: { repoOwner: string }): Promise<Capability[]> => {
    const team = await resolveTeamForProject(project);
    return getEffectiveCapabilitiesForTeam(user, team);
};

// === Request-scoped helpers (mirror the requireLeader(req,res) pattern: send the response and
// return false on failure so handlers can early-return). ===

export const getRequestUser = async (req: express.Request): Promise<User | null> => {
    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, '');
    return getUserByAuthTokenModel(token);
};

export const requireAdmin = async (req: express.Request, res: express.Response): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    if (!(await isAdminUser(user))) return void res.status(403).send('Forbidden'), false;
    return true;
};

export const requireSuperAdmin = async (req: express.Request, res: express.Response): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    if (!isSuperAdmin(user)) return void res.status(403).send('Forbidden'), false;
    return true;
};

export const requireProjectCapability = async (req: express.Request, res: express.Response, projectId: string, cap: Capability): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    const project = await getProjectByIdModel(projectId);
    if (!project) return void res.status(404).send('Project not found'), false;
    const caps = await getEffectiveCapabilitiesForProject(user, { repoOwner: project.repoOwner });
    if (!caps.includes(cap)) return void res.status(403).send('Forbidden'), false;
    return true;
};

export const requireTeamCapability = async (req: express.Request, res: express.Response, ownerId: string, cap: Capability): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    const team = await resolveTeamById(ownerId);
    if (!team) return void res.status(404).send('Team not found'), false;
    const caps = await getEffectiveCapabilitiesForTeam(user, team);
    if (!caps.includes(cap)) return void res.status(403).send('Forbidden'), false;
    return true;
};

// Gate a team-management write on the requester being an NSM admin or the team's GitHub owner, and
// on the team currently being installed (defaults/overrides can't be edited while uninstalled).
export const requireTeamManage = async (req: express.Request, res: express.Response, ownerId: string): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    const team = await resolveTeamById(ownerId);
    if (!team) return void res.status(404).send('Team not found'), false;
    if (!team.installed) return void res.status(409).send(`The NSM GitHub App is not installed on ${team.login}.`), false;
    if (!(await canManageTeam(user, team))) return void res.status(403).send('Forbidden'), false;
    return true;
};

// Gate project creation on CREATE_PROJECT within the team of the chosen repo owner. Also enforces
// that the owner's App is installed (an uninstalled/unknown owner has no accessible team).
export const requireCreateProjectForOwner = async (req: express.Request, res: express.Response, repoOwner: string): Promise<boolean> => {
    const user = await getRequestUser(req);
    if (!user) return void res.status(401).send('Unauthorized'), false;
    const team = await resolveTeamByLogin(repoOwner);
    if (!team || !team.installed) return void res.status(403).send(`The NSM GitHub App is not installed on ${repoOwner}.`), false;
    const caps = await getEffectiveCapabilitiesForTeam(user, team);
    if (!caps.includes(Capability.CREATE_PROJECT)) return void res.status(403).send('Forbidden'), false;
    return true;
};

// Gate a request on the project's owner team being installed (deploys clone via the App, and an
// uninstalled team is inaccessible). Sends a clear message when the App is missing.
export const requireOwnerInstalledForProject = async (res: express.Response, projectId: string): Promise<boolean> => {
    const project = await getProjectByIdModel(projectId);
    if (!project) return void res.status(404).send('Project not found'), false;
    if (!(await isOwnerInstalled(project.repoOwner))) return void res.status(409).send(`The NSM GitHub App is not installed on ${project.repoOwner}. Reinstall it to manage or deploy this project.`), false;
    return true;
};
