import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { API_BODY, API_PARAMS, API_RETURN, API_ROUTES } from '@mosaiq/nsm-common/routes';
import { NodeStatusReport } from '@mosaiq/nsm-common/types';
import { createProject, deleteProject, getAllProjects, getProject, resetDeploymentKey, setProjectAssignment, syncProjectToRepoData, teardownProjectWithCleanup, updateProject, verifyDeploymentKey } from '@/controllers/projectController';
import { planLocally, updateDeploymentLog, promoteDeployment, cancelDeploy } from '@/controllers/deployController';
import { enqueueDeploy } from '@/controllers/deployQueue';
import { updateEnvironmentVariable } from '@/controllers/secretController';
import { getProjectInstance } from '@/controllers/projectInstanceController';
import { getControlPlaneStatus } from '@/controllers/statusController';
import { queryLogs, queryMetric, queryNsmLogs, queryStructuredLogs, queryLogFacets, queryNodeMetric, getNodeStorageSpec, queryNodeStorageSeries, MetricKind } from '@/controllers/observabilityController';
import { NodeMetricKind } from '@mosaiq/nsm-common/types';
import { collectDiskUsage } from '@/reconcile/diskUsage';
import { getGithubAuthTokenFromTempCode } from '@/utils/authUtils';
import { signInUser, signOutUser, verifyAuthToken } from '@/controllers/userController';
import { Capability } from '@mosaiq/nsm-common/types';
import { getEffectiveCapabilitiesForProject, getRequestUser, requireAdmin, requireCreateProjectForOwner, requireOwnerInstalledForProject, requireProjectCapability, requireSuperAdmin, requireTeamManage } from '@/controllers/authz';
import { buildMeResponse, clearTeamOverride, getTeamDetail, getVisibleProjects, listAllTeams, redactProjectSecrets, setTeamDefaults, setTeamOverride } from '@/controllers/teamController';
import { addAdmin, getAdmins, removeAdmin } from '@/controllers/adminController';
import { removeManagedCd, setupManagedCd } from '@/controllers/cicdController';
import { getVapidPublicKey, regenerateVapidKeys, subscribe, unsubscribe } from '@/controllers/pushController';
import { getAllNodesModel, getNodeByIdModel } from '@/persistence/nodePersistence';
import { config, gitSshKeyPath, isGithubAppConfigured } from '@/config';
import { mintInstallationToken, listInstallationOwners, listInstallationRepos, listRepoBranches } from '@/utils/githubApp';
import { cluster } from '@/cluster/node';
import { CLUSTER_SECRET_HEADER, forwardToLeader, postToNode } from '@/cluster/leaderClient';
import { ingestReport } from '@/cluster/statusGossip';
import { registerNode, deregisterNode, getRegistry } from '@/cluster/registry';
import { getDesiredDeploymentsAssignedToModel } from '@/persistence/desiredDeploymentPersistence';
import { applyUpdateInstruction, setDesiredNsmVersion } from '@/cluster/selfUpdate';
import { purgeProjectLocal, teardownProjectLocal } from '@/reconcile/teardown';
import { cancelLocalDeployment } from '@/reconcile/deploy';
import { registry } from '@/utils/metrics';
import { areaLog } from '@/utils/log';

const routeLog = areaLog('routes');

const publicRouter = express.Router();
const privateRouter = express.Router();
const internalRouter = express.Router();

// The externally reachable base URL of this node, taken from trusted server config (config.publicUrl)
// rather than request headers: this value is spliced into the root-executed install.sh and the
// join command, so a client-controllable Host/X-Forwarded-Host must never reach it. Returns null if
// the configured URL is malformed, so callers can refuse rather than emit an injectable artifact.
const PUBLIC_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const safePublicUrl = (): string | null => {
    const base = config.publicUrl.replace(/\/+$/, '');
    return PUBLIC_URL_RE.test(base) ? base : null;
};

// Returns false (and forwards to leader) if this node is not the leader. Use in write handlers.
const requireLeader = (req: express.Request, res: express.Response): boolean => {
    if (!cluster.isLeader()) {
        void forwardToLeader(req, res);
        return false;
    }
    return true;
};

// === Auth middlewares ===
privateRouter.use(async (req, res, next) => {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader?.length || typeof authHeader !== 'string') {
        res.status(401).send('Unauthorized');
        return;
    }
    // The browser SPA sends `Authorization: Bearer <token>`; CI/CD and tests send the raw token.
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!(await verifyAuthToken(token))) {
        res.status(403).send('Forbidden');
        return;
    }
    next();
});

// Per-route guard (NOT a blanket router.use): a blanket middleware here would run for every
// request flowing through this router and 403 non-internal requests before they reach the
// private/static routers mounted after it. Applied explicitly to each internal route instead.
const requireClusterSecret = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const secret = req.headers[CLUSTER_SECRET_HEADER];
    if (secret !== config.clusterSecret) {
        res.status(403).send('Forbidden');
        return;
    }
    next();
};

// === Public ===
publicRouter.get('/healthz', async (_req, res) => {
    res.status(200).json({ ok: true, nodeId: config.nodeId, version: config.version, isLeader: cluster.isLeader(), leader: cluster.leaderAddress() });
});

// Prometheus scrape target (per node). Exposes counters/histograms only.
publicRouter.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.status(200).send(await registry.metrics());
});

// Serves the universal installer, templated with this node's URL so followers can join with just
// their cluster secret: `curl -fsSL <leader>/install.sh | sudo bash -s -- --secret <TOKEN>`.
publicRouter.get('/install.sh', async (_req, res) => {
    try {
        const base = safePublicUrl();
        if (!base) {
            routeLog.error({ action: 'install_sh_bad_url', publicUrl: config.publicUrl }, 'refusing to serve install.sh: config.publicUrl is not a valid URL');
            return void res.status(500).send('server misconfigured');
        }
        const script = await fs.promises.readFile(path.join(config.nsmRepoDir, 'install.sh'), 'utf-8');
        const templated = script.replace('NSM_LEADER_DEFAULT="${NSM_LEADER_DEFAULT:-}"', () => `NSM_LEADER_DEFAULT="${base}"`);
        res.setHeader('Content-Type', 'text/x-shellscript');
        res.status(200).send(templated);
    } catch (e) {
        routeLog.error({ action: 'install_sh_error', err: (e as any)?.message }, 'error serving install.sh');
        res.status(500).send();
    }
});

publicRouter.get('/auth/github', async (req, res) => {
    try {
        const { code, error, error_description, error_uri } = req.query;
        if (error) {
            res.status(302).redirect(`${process.env.FRONTEND_URL}?error=${error}&error_description=${error_description}&error_uri=${error_uri}`);
            return;
        }
        if (!code || typeof code !== 'string') {
            res.status(400).send('No code provided');
            return;
        }
        const token = await getGithubAuthTokenFromTempCode(code);
        if (!token) {
            res.status(401).send('Unauthorized');
            return;
        }
        res.status(302).redirect(`${process.env.FRONTEND_URL}?token=${token}`);
    } catch (error) {
        routeLog.error({ action: 'auth_github_error', err: (error as any)?.message }, 'error handling GitHub auth callback');
        res.status(500).send();
    }
});

// Deploy webhook (CI/CD). Write -> must run on leader.
publicRouter.get(API_ROUTES.GET_DEPLOY, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_DEPLOY];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!params.key) return void res.status(401).send('Unauthorized');
        if (!(await verifyDeploymentKey(params.projectId, params.key, false))) return void res.status(403).send('Forbidden');
        if (!requireLeader(req, res)) return;
        if (!(await requireOwnerInstalledForProject(res, params.projectId))) return;
        await enqueueDeploy(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'deploy_webhook_error', err: (e as any)?.message }, 'error deploying (webhook)');
        res.status(500).send();
    }
});

publicRouter.post(API_ROUTES.POST_GITHUB_LOGIN, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_GITHUB_LOGIN];
    try {
        if (!params.token) return void res.status(400).send('No token');
        if (!requireLeader(req, res)) return; // sign-in writes replicated user state
        const user = await signInUser(params.token);
        if (!user) return void res.status(401).send('Unauthorized');
        res.status(200).json(user);
    } catch (e) {
        routeLog.error({ action: 'github_login_error', err: (e as any)?.message }, 'error with GitHub login');
        res.status(500).send();
    }
});

// === Private (user-authenticated) reads ===
// Permission-filtered reads run on the leader (where team/membership resolution and the GitHub App
// live); followers forward via requireLeader.
privateRouter.get(API_ROUTES.GET_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_PROJECT];
    if (!requireLeader(req, res)) return;
    if (!(await requireProjectCapability(req, res, params.projectId, Capability.VIEW))) return;
    const project = await getProject(params.projectId);
    if (!project) return void res.status(404).send('Project not found');
    const user = await getRequestUser(req);
    const caps = user ? await getEffectiveCapabilitiesForProject(user, { repoOwner: project.repoOwner }) : [];
    res.status(200).json(redactProjectSecrets(project, caps.includes(Capability.CONFIGURE)));
});

privateRouter.get(API_ROUTES.GET_PROJECTS, async (req, res) => {
    try {
        if (!requireLeader(req, res)) return;
        const user = await getRequestUser(req);
        if (!user) return void res.status(401).send('Unauthorized');
        res.status(200).json(await getVisibleProjects(user));
    } catch (e) {
        routeLog.error({ action: 'list_projects_error', err: (e as any)?.message }, 'error listing projects');
        res.status(500).send();
    }
});

privateRouter.get(API_ROUTES.GET_PROJECT_INSTANCE, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_PROJECT_INSTANCE];
    if (!requireLeader(req, res)) return;
    const instance = await getProjectInstance(params.projectInstanceId);
    if (!instance) return void res.status(404).send('Project instance not found');
    if (!(await requireProjectCapability(req, res, instance.projectId, Capability.VIEW))) return;
    res.status(200).json(instance);
});

privateRouter.get(API_ROUTES.GET_WORKER_NODES, async (_req, res) => {
    const nodes = await getAllNodesModel();
    res.status(200).json(nodes);
});

privateRouter.get(API_ROUTES.GET_WORKER_STATUSES, async (_req, res) => {
    res.status(200).json(undefined);
});

// Everything a new node needs to join: the one-line install command (with this leader's URL and
// the cluster secret baked in) and the shared deploy public key to register on GitHub.
privateRouter.get(API_ROUTES.GET_JOIN_INFO, async (_req, res) => {
    const base = safePublicUrl();
    if (!base) {
        routeLog.error({ action: 'join_info_bad_url', publicUrl: config.publicUrl }, 'cannot build join command: config.publicUrl is not a valid URL');
        return void res.status(500).send('server misconfigured');
    }
    const command = `curl -fsSL ${base}/install.sh | sudo bash -s -- --secret ${config.clusterSecret}`;
    let deployPublicKey: string | null = null;
    try {
        deployPublicKey = (await fs.promises.readFile(`${gitSshKeyPath()}.pub`, 'utf-8')).trim();
    } catch {
        deployPublicKey = null;
    }
    const payload: API_RETURN[API_ROUTES.GET_JOIN_INFO] = { command, deployPublicKey };
    res.status(200).json(payload);
});

privateRouter.get(API_ROUTES.GET_CONTROL_PLANE_STATUS, async (_req, res) => {
    res.status(200).json(await getControlPlaneStatus());
});

// The permission-aware view driving the UI: the signed-in user's teams, projects and capabilities.
privateRouter.get(API_ROUTES.GET_ME, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const user = await getRequestUser(req);
        if (!user) return void res.status(401).send('Unauthorized');
        res.status(200).json(await buildMeResponse(user));
    } catch (e) {
        routeLog.error({ action: 'me_error', err: (e as any)?.message }, 'error building me response');
        res.status(500).send();
    }
});

// Teams management (admin only): installed teams merged with configured-but-uninstalled ones.
privateRouter.get(API_ROUTES.GET_TEAMS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    if (!(await requireAdmin(req, res))) return;
    try {
        res.status(200).json(await listAllTeams());
    } catch (e) {
        routeLog.error({ action: 'list_teams_error', err: (e as any)?.message }, 'error listing teams');
        res.status(500).send();
    }
});

// Team detail + dynamic member list. Visible to anyone who can manage the team (admin or owner) or
// is a member; managing/editing is gated separately on the write routes.
privateRouter.get(API_ROUTES.GET_TEAM, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_TEAM];
    if (!requireLeader(req, res)) return;
    try {
        const user = await getRequestUser(req);
        if (!user) return void res.status(401).send('Unauthorized');
        const detail = await getTeamDetail(user, params.ownerId);
        if (!detail) return void res.status(404).send('Team not found');
        // Only admins/owners/members should see a team's member list.
        if (!detail.canManage && detail.team.installed) {
            const meCaps = await buildMeResponse(user);
            const isMember = meCaps.teams.some((t) => t.ownerId === detail.team.ownerId && t.capabilities.length > 0);
            if (!isMember) return void res.status(403).send('Forbidden');
        } else if (!detail.canManage && !detail.team.installed) {
            return void res.status(403).send('Forbidden');
        }
        res.status(200).json(detail);
    } catch (e) {
        routeLog.error({ action: 'get_team_error', err: (e as any)?.message }, 'error getting team detail');
        res.status(500).send();
    }
});

// Admin management (super admin only).
privateRouter.get(API_ROUTES.GET_ADMINS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    if (!(await requireSuperAdmin(req, res))) return;
    res.status(200).json(await getAdmins());
});

// Observability query proxy (leader-only, where the Loki/Prometheus stack lives). Followers
// forward to the leader via requireLeader.
privateRouter.get(API_ROUTES.GET_OBSERVABILITY_LOGS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { projectInstanceId, serviceInstanceId, projectId, start, end, limit } = req.query as Record<string, string>;
        res.status(200).json(await queryLogs({ projectInstanceId, serviceInstanceId, projectId }, start, end, Number(limit) || 500));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

privateRouter.get(API_ROUTES.GET_OBSERVABILITY_METRICS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { projectInstanceId, serviceInstanceId, projectId, metric, start, end, step } = req.query as Record<string, string>;
        res.status(200).json(await queryMetric({ projectInstanceId, serviceInstanceId, projectId }, (metric as MetricKind) || 'cpu', start, end, step || '30s'));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// Host-level CPU/mem/net/disk time series for one node (from node_exporter). Leader-only.
privateRouter.get(API_ROUTES.GET_NODE_METRICS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { nodeId, metric, start, end, step } = req.query as Record<string, string>;
        if (!nodeId) return void res.status(400).send('nodeId required');
        res.status(200).json(await queryNodeMetric(nodeId, (metric as NodeMetricKind) || 'cpu', start, end, step || '30s'));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// Latest per-node storage spec (filesystems + per-project volume/code breakdown), read from
// Prometheus without triggering a live disk scan. Leader-only.
privateRouter.get(API_ROUTES.GET_NODE_STORAGE, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { nodeId } = req.query as Record<string, string>;
        if (!nodeId) return void res.status(400).send('nodeId required');
        res.status(200).json(await getNodeStorageSpec(nodeId));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// Per-project disk usage over time for a node (plus a node-summed series). Leader-only.
privateRouter.get(API_ROUTES.GET_NODE_STORAGE_SERIES, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { nodeId, start, end, step } = req.query as Record<string, string>;
        if (!nodeId) return void res.status(400).send('nodeId required');
        res.status(200).json(await queryNodeStorageSeries(nodeId, start, end, step || '30s'));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// On-demand disk snapshot: run a fresh scan on the target node and return the live storage spec.
// The scan also updates the node's gauge, so the fresh values land in Prometheus at the next scrape.
privateRouter.post(API_ROUTES.POST_NODE_STORAGE_SNAPSHOT, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { nodeId } = (req.body || {}) as { nodeId?: string };
        if (!nodeId) return void res.status(400).send('nodeId required');
        if (nodeId === config.nodeId) return void res.status(200).json(await collectDiskUsage());
        const node = await getNodeByIdModel(nodeId);
        if (!node) return void res.status(404).send('node not found');
        const spec = await postToNode(node.address, node.apiPort, '/node/disk-snapshot', {}, 120000);
        if (!spec) return void res.status(502).send('failed to reach node for snapshot');
        res.status(200).json(spec);
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// nsmd's own control-plane logs (leader-only, where Loki lives). Optionally filtered to one node.
privateRouter.get(API_ROUTES.GET_NSM_LOGS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const { nodeId, start, end, limit } = req.query as Record<string, string>;
        res.status(200).json(await queryNsmLogs(nodeId || undefined, start, end, Number(limit) || 500));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// Structured log query (Datadog-style viewer): selector + search + field filters + level + paging.
// Leader-only, where the Loki stack lives; followers forward.
privateRouter.post(API_ROUTES.POST_LOG_QUERY, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const body = req.body as API_BODY[API_ROUTES.POST_LOG_QUERY];
        if (!body?.selector || !body.startNs || !body.endNs) return void res.status(400).send('selector, startNs and endNs are required');
        res.status(200).json(await queryStructuredLogs(body));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// Facet value counts for the same selector/filters, powering the viewer's facet sidebar.
privateRouter.post(API_ROUTES.POST_LOG_FACETS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const body = req.body as API_BODY[API_ROUTES.POST_LOG_FACETS];
        if (!body?.selector || !body.startNs || !body.endNs || !Array.isArray(body.fields)) return void res.status(400).send('selector, startNs, endNs and fields are required');
        res.status(200).json(await queryLogFacets(body));
    } catch (e: any) {
        res.status(400).send(e.message);
    }
});

// GitHub App-backed suggestions for the create-project form. Leader-only (only the leader holds the
// App private key). These degrade to an empty list on any failure so the form's free-text entry
// still works when the App isn't configured or GitHub is unreachable.
privateRouter.get(API_ROUTES.GET_GITHUB_OWNERS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    if (!isGithubAppConfigured()) return void res.status(200).json([]);
    try {
        res.status(200).json(await listInstallationOwners());
    } catch (e) {
        routeLog.error({ action: 'list_github_owners_error', err: (e as any)?.message }, 'error listing GitHub App owners');
        res.status(200).json([]);
    }
});

privateRouter.get(API_ROUTES.GET_GITHUB_REPOS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const owner = String((req.query as Record<string, string>).owner || '').trim();
    if (!owner) return void res.status(400).send('owner required');
    if (!isGithubAppConfigured()) return void res.status(200).json([]);
    try {
        res.status(200).json(await listInstallationRepos(owner));
    } catch (e) {
        routeLog.error({ action: 'list_github_repos_error', owner, err: (e as any)?.message }, `error listing GitHub repos for ${owner}`);
        res.status(200).json([]);
    }
});

privateRouter.get(API_ROUTES.GET_GITHUB_BRANCHES, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const { owner, repo } = req.query as Record<string, string>;
    if (!owner?.trim() || !repo?.trim()) return void res.status(400).send('owner and repo required');
    if (!isGithubAppConfigured()) return void res.status(200).json([]);
    try {
        res.status(200).json(await listRepoBranches(owner.trim(), repo.trim()));
    } catch (e) {
        routeLog.error({ action: 'list_github_branches_error', owner, repo, err: (e as any)?.message }, `error listing GitHub branches for ${owner}/${repo}`);
        res.status(200).json([]);
    }
});

privateRouter.get(API_ROUTES.GET_DEPLOY_WEB, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_DEPLOY_WEB];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!(await verifyDeploymentKey(params.projectId, params.key, true))) return void res.status(403).send('Forbidden');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.DEPLOY))) return;
        if (!(await requireOwnerInstalledForProject(res, params.projectId))) return;
        const logId = await enqueueDeploy(params.projectId);
        res.status(200).json(logId);
    } catch (e) {
        routeLog.error({ action: 'deploy_web_error', err: (e as any)?.message }, 'error deploying (web)');
        res.status(500).send();
    }
});

// === Private writes (forwarded to leader when needed) ===
privateRouter.post(API_ROUTES.POST_CREATE_PROJECT, async (req, res) => {
    const body = req.body as API_BODY[API_ROUTES.POST_CREATE_PROJECT];
    try {
        if (!body || !body.id || !body.repoOwner || !body.repoName) return void res.status(400).send('Invalid request body');
        if (!requireLeader(req, res)) return;
        if (!(await requireCreateProjectForOwner(req, res, body.repoOwner))) return;
        res.status(200).json(await createProject(body));
    } catch (e) {
        routeLog.error({ action: 'create_project_error', err: (e as any)?.message }, 'error creating project');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_UPDATE_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_UPDATE_PROJECT];
    const body = req.body as API_BODY[API_ROUTES.POST_UPDATE_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        await updateProject(params.projectId, body);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'update_project_error', err: (e as any)?.message }, 'error updating project');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_DELETE_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_DELETE_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.DELETE))) return;
        await deleteProject(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'delete_project_error', err: (e as any)?.message }, 'error deleting project');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_RESET_DEPLOYMENT_KEY];
    try {
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        const newKey = await resetDeploymentKey(params.projectId);
        if (!newKey) return void res.status(404).send('Project not found');
        res.status(200).json(newKey);
    } catch (e) {
        routeLog.error({ action: 'reset_deployment_key_error', err: (e as any)?.message }, 'error resetting deployment key');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_UPDATE_ENV_VAR, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_UPDATE_ENV_VAR];
    const body = req.body as API_BODY[API_ROUTES.POST_UPDATE_ENV_VAR];
    try {
        if (!params.projectId || !body.secretName) return void res.status(400).send('Invalid request');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        await updateEnvironmentVariable(params.projectId, body);
        res.status(200).send('Environment variable updated');
    } catch (e) {
        routeLog.error({ action: 'update_env_var_error', err: (e as any)?.message }, 'error updating environment variable');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SYNC_TO_REPO, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SYNC_TO_REPO];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        const project = await syncProjectToRepoData(params.projectId);
        if (!project) return void res.status(404).send('Project not found');
        res.status(200).json(project);
    } catch (e) {
        routeLog.error({ action: 'sync_to_repo_error', err: (e as any)?.message }, 'error syncing project to repo data');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_TEARDOWN_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_TEARDOWN_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.DEPLOY))) return;
        await teardownProjectWithCleanup(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'teardown_project_error', err: (e as any)?.message }, 'error tearing down project');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_CANCEL_DEPLOY, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_CANCEL_DEPLOY];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.DEPLOY))) return;
        await cancelDeploy(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'cancel_deploy_error', err: (e as any)?.message }, 'error cancelling deployment');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SET_PROJECT_ASSIGNMENT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SET_PROJECT_ASSIGNMENT];
    const body = req.body as API_BODY[API_ROUTES.POST_SET_PROJECT_ASSIGNMENT];
    try {
        if (!params.projectId || !body.nodeId) return void res.status(400).send('Invalid request');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        await setProjectAssignment(params.projectId, body.nodeId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'assign_project_error', err: (e as any)?.message }, 'error assigning project');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_CICD_SETUP, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_CICD_SETUP];
    const body = req.body as API_BODY[API_ROUTES.POST_CICD_SETUP];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!body.branch || !body.triggers?.length) return void res.status(400).send('A branch and at least one trigger are required');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        if (!(await requireOwnerInstalledForProject(res, params.projectId))) return;
        const project = await setupManagedCd(params.projectId, body);
        if (!project) return void res.status(404).send('Project not found');
        res.status(200).json(project);
    } catch (e) {
        routeLog.error({ action: 'cicd_setup_error', err: (e as any)?.message }, 'error setting up managed CI/CD');
        res.status(500).send((e as any)?.message || 'Failed to set up CI/CD');
    }
});

privateRouter.post(API_ROUTES.POST_CICD_REMOVE, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_CICD_REMOVE];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        if (!(await requireProjectCapability(req, res, params.projectId, Capability.CONFIGURE))) return;
        if (!(await requireOwnerInstalledForProject(res, params.projectId))) return;
        const project = await removeManagedCd(params.projectId);
        if (!project) return void res.status(404).send('Project not found');
        res.status(200).json(project);
    } catch (e) {
        routeLog.error({ action: 'cicd_remove_error', err: (e as any)?.message }, 'error removing managed CI/CD');
        res.status(500).send((e as any)?.message || 'Failed to remove CI/CD');
    }
});

// === Team management writes (team owner or NSM admin) ===
privateRouter.post(API_ROUTES.POST_SET_TEAM_DEFAULTS, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SET_TEAM_DEFAULTS];
    const body = req.body as API_BODY[API_ROUTES.POST_SET_TEAM_DEFAULTS];
    try {
        if (!requireLeader(req, res)) return;
        if (!(await requireTeamManage(req, res, params.ownerId))) return;
        await setTeamDefaults(params.ownerId, body.capabilities || []);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'set_team_defaults_error', err: (e as any)?.message }, 'error setting team defaults');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SET_TEAM_OVERRIDE, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SET_TEAM_OVERRIDE];
    const body = req.body as API_BODY[API_ROUTES.POST_SET_TEAM_OVERRIDE];
    try {
        if (!body?.memberId) return void res.status(400).send('memberId required');
        if (!requireLeader(req, res)) return;
        if (!(await requireTeamManage(req, res, params.ownerId))) return;
        await setTeamOverride(params.ownerId, body.memberId, body.memberLogin || '', body.capabilities || []);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'set_team_override_error', err: (e as any)?.message }, 'error setting team override');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_DELETE_TEAM_OVERRIDE, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_DELETE_TEAM_OVERRIDE];
    const body = req.body as API_BODY[API_ROUTES.POST_DELETE_TEAM_OVERRIDE];
    try {
        if (!body?.memberId) return void res.status(400).send('memberId required');
        if (!requireLeader(req, res)) return;
        if (!(await requireTeamManage(req, res, params.ownerId))) return;
        await clearTeamOverride(params.ownerId, body.memberId);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'delete_team_override_error', err: (e as any)?.message }, 'error deleting team override');
        res.status(500).send();
    }
});

// === Admin management writes (super admin only) ===
privateRouter.post(API_ROUTES.POST_ADD_ADMIN, async (req, res) => {
    const body = req.body as API_BODY[API_ROUTES.POST_ADD_ADMIN];
    try {
        if (!body?.login) return void res.status(400).send('login required');
        if (!requireLeader(req, res)) return;
        if (!(await requireSuperAdmin(req, res))) return;
        const admin = await addAdmin(body.login);
        if (!admin) return void res.status(404).send('GitHub user not found');
        res.status(200).json(admin);
    } catch (e) {
        routeLog.error({ action: 'add_admin_error', err: (e as any)?.message }, 'error adding admin');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_REMOVE_ADMIN, async (req, res) => {
    const body = req.body as API_BODY[API_ROUTES.POST_REMOVE_ADMIN];
    try {
        if (!body?.id) return void res.status(400).send('id required');
        if (!requireLeader(req, res)) return;
        if (!(await requireSuperAdmin(req, res))) return;
        await removeAdmin(body.id);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'remove_admin_error', err: (e as any)?.message }, 'error removing admin');
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_GITHUB_LOGOUT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_GITHUB_LOGOUT];
    try {
        if (!params.token) return void res.status(400).send('No token');
        if (!requireLeader(req, res)) return;
        await signOutUser(params.token);
        res.status(200).send('Logged out');
    } catch (e) {
        routeLog.error({ action: 'github_logout_error', err: (e as any)?.message }, 'error with GitHub logout');
        res.status(500).send();
    }
});

// === Web Push ===
// The VAPID public key the browser needs to create a subscription. Only the leader holds the
// authoritative key pair, so forward to it.
privateRouter.get(API_ROUTES.GET_VAPID_PUBLIC_KEY, async (req, res) => {
    if (!requireLeader(req, res)) return;
    res.status(200).json(getVapidPublicKey());
});

// Regenerate the VAPID key pair (leader-owned). Clears existing subscriptions; refused when keys
// are pinned via environment config.
privateRouter.post(API_ROUTES.POST_REGENERATE_VAPID, async (req, res) => {
    try {
        if (!requireLeader(req, res)) return;
        res.status(200).json(await regenerateVapidKeys());
    } catch (e) {
        routeLog.error({ action: 'regenerate_vapid_error', err: (e as any)?.message }, 'error regenerating VAPID keys');
        res.status(500).send();
    }
});

// Store a browser push subscription for the signed-in user. Writes replicated user-scoped state,
// so it must land on the leader.
privateRouter.post(API_ROUTES.POST_PUSH_SUBSCRIBE, async (req, res) => {
    try {
        if (!requireLeader(req, res)) return;
        const token = (req.headers['authorization'] || '').toString().replace(/^Bearer\s+/i, '');
        const body = req.body as API_BODY[API_ROUTES.POST_PUSH_SUBSCRIBE];
        const ok = await subscribe(token, body);
        if (!ok) return void res.status(400).send('Invalid subscription');
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'push_subscribe_error', err: (e as any)?.message }, 'error saving push subscription');
        res.status(500).send();
    }
});

// Remove a browser push subscription (opt-out / sign-out cleanup).
privateRouter.post(API_ROUTES.POST_PUSH_UNSUBSCRIBE, async (req, res) => {
    try {
        if (!requireLeader(req, res)) return;
        const body = req.body as API_BODY[API_ROUTES.POST_PUSH_UNSUBSCRIBE];
        await unsubscribe(body?.endpoint);
        res.status(200).json(undefined);
    } catch (e) {
        routeLog.error({ action: 'push_unsubscribe_error', err: (e as any)?.message }, 'error removing push subscription');
        res.status(500).send();
    }
});

// === Internal cluster routes (cluster-secret authenticated) ===
// A node announces itself (and its current IP) to the leader; returns the registry snapshot.
internalRouter.post('/cluster/register', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        await registerNode(req.body);
        res.status(200).json(await getRegistry());
    } catch (e: any) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

internalRouter.post('/cluster/deregister', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    await deregisterNode(req.body?.nodeId);
    res.status(200).json({ ok: true });
});

// Streams the leader's NSM source tree so a joining follower can install without cloning from
// GitHub. Secret-gated; excludes secrets and build artifacts.
internalRouter.get('/install/bundle.tgz', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const excludes = ['node_modules', '.git', '.env', '.env.local', '.devdata', 'coverage', 'dist'];
    const args = ['czf', '-', ...excludes.flatMap((e) => ['--exclude', e]), '-C', config.nsmRepoDir, '.'];
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="bundle.tgz"');
    const tar = spawn('tar', args);
    tar.stdout.pipe(res);
    tar.stderr.on('data', (d) => routeLog.error({ action: 'bundle_tar_stderr', out: d.toString() }, 'bundle tar stderr'));
    tar.on('error', (e) => {
        routeLog.error({ action: 'bundle_tar_spawn_failed', err: (e as any)?.message }, 'failed to spawn tar for bundle');
        if (!res.headersSent) res.status(500);
        res.end();
    });
});

// Mints a short-lived, repo-scoped GitHub App installation token for a follower to clone a private
// app repo. Leader-only (only the leader holds the App private key); secret-gated. The token is
// never logged.
internalRouter.post('/cluster/git-token', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    if (!isGithubAppConfigured()) return void res.status(501).send('GitHub App not configured');
    const { repoOwner, repoName } = req.body || {};
    if (!repoOwner || !repoName) return void res.status(400).send('repoOwner + repoName required');
    try {
        res.status(200).json(await mintInstallationToken(String(repoOwner), String(repoName)));
    } catch (e: any) {
        routeLog.error({ action: 'git_token_mint_failed', repoOwner, repoName, err: e?.message || String(e) }, `failed to mint git token for ${repoOwner}/${repoName}`);
        res.status(502).send('failed to mint installation token');
    }
});

// Hands the shared git deploy private key to a joining follower so it can clone app repos. This is
// deliberately secret-gated: the cluster secret is the join credential.
internalRouter.get('/cluster/deploy-key', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    try {
        const key = await fs.promises.readFile(gitSshKeyPath(), 'utf-8');
        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send(key);
    } catch (e) {
        routeLog.error({ action: 'read_deploy_key_error', err: (e as any)?.message }, 'error reading deploy key');
        res.status(404).send('deploy key not found');
    }
});

// Follower pull: returns the desired deployments assigned to a node + the registry snapshot.
internalRouter.post('/node/desired', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const nodeId = String(req.body?.nodeId || '');
    const deployments = await getDesiredDeploymentsAssignedToModel(nodeId);
    res.status(200).json({ deployments, registry: (await getRegistry()).nodes });
});

// Deployment log updates reported by owning nodes -> stored by the leader.
internalRouter.post('/cluster/log', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const { logId, status, log } = req.body || {};
    if (logId) await updateDeploymentLog(logId, status, log || '');
    res.status(200).json(undefined);
});

// A node reports its new (blue) generation ready -> leader promotes it (flips nginx to the new
// ports) and deactivates superseded instances.
internalRouter.post('/cluster/deploy-ready', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const { projectId, generation, nodeId } = req.body || {};
    if (!projectId || typeof generation !== 'number') return void res.status(400).send('projectId + generation required');
    await promoteDeployment(String(projectId), generation, String(nodeId || ''));
    res.status(200).json(undefined);
});

// Status gossip from nodes -> cached by the leader.
internalRouter.post('/cluster/status-report', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    await ingestReport(req.body as NodeStatusReport);
    res.status(200).json(undefined);
});

// Leader asks a node to allocate ports + ensure directories for a deployment.
internalRouter.post('/node/plan', requireClusterSecret, async (req, res) => {
    const { proxyCount, dirs } = req.body || {};
    res.status(200).json(await planLocally(proxyCount || 0, dirs || {}));
});

// Leader asks a node to purge a deleted project: tear down containers + deploy dir, then archive
// (rename) the persistent dir. Fire-and-forget: teardown can take minutes, past the RPC timeout.
internalRouter.post('/node/purge-project', requireClusterSecret, async (req, res) => {
    const { projectId } = req.body || {};
    res.status(200).json(undefined);
    if (projectId) void purgeProjectLocal(String(projectId));
});

// Leader asks a node to tear down a project without archiving its persistent dir (teardown, not
// delete). Fire-and-forget: teardown can take minutes, past the RPC timeout.
internalRouter.post('/node/teardown-project', requireClusterSecret, async (req, res) => {
    const { projectId } = req.body || {};
    res.status(200).json(undefined);
    if (projectId) void teardownProjectLocal(String(projectId));
});

// Leader asks a node to run a fresh disk-usage scan now and return its storage spec. The scan also
// refreshes this node's Prometheus gauge so the on-demand snapshot lands in the time series.
internalRouter.post('/node/disk-snapshot', requireClusterSecret, async (_req, res) => {
    try {
        res.status(200).json(await collectDiskUsage());
    } catch (e: any) {
        routeLog.error({ action: 'disk_snapshot_error', err: e?.message }, 'error collecting disk snapshot');
        res.status(500).send(e?.message);
    }
});

// Leader asks the owning node to cancel an in-flight deployment: SIGKILL the build so it stops
// immediately (its failure/rollback path then tears down the partial generation).
internalRouter.post('/node/cancel-deploy', requireClusterSecret, async (req, res) => {
    const { projectId } = req.body || {};
    if (projectId) cancelLocalDeployment(String(projectId));
    res.status(200).json(undefined);
});

// CI/CD sets the desired NSM version (leader records it; rollout is orchestrated).
internalRouter.post('/cluster/self-update', requireClusterSecret, async (req, res) => {
    if (!requireLeader(req, res)) return;
    const { version, artifactRef } = req.body || {};
    if (!version || !artifactRef) return void res.status(400).send('version + artifactRef required');
    await setDesiredNsmVersion(version, artifactRef);
    res.status(200).json(undefined);
});

// A node is instructed to upgrade itself.
internalRouter.post('/cluster/apply-update', requireClusterSecret, async (req, res) => {
    const { artifactRef } = req.body || {};
    res.status(200).json(undefined);
    if (artifactRef) void applyUpdateInstruction(artifactRef);
});

// === Dev/test-only helpers (disabled in production) ===
internalRouter.post('/cluster/dev-propose', requireClusterSecret, async (req, res) => {
    if (config.production) return void res.status(404).send();
    if (!requireLeader(req, res)) return;
    try {
        await cluster.propose(req.body);
        res.status(200).json({ ok: true });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

internalRouter.get('/cluster/dev-dump', requireClusterSecret, async (_req, res) => {
    if (config.production) return void res.status(404).send();
    const projects = await getAllProjects();
    const nodes = await getAllNodesModel();
    res.status(200).json({ nodeId: config.nodeId, isLeader: cluster.isLeader(), leader: cluster.leaderAddress(), projectIds: projects.map((p) => p.id), nodeIds: nodes.map((n) => n.nodeId) });
});

export { publicRouter, privateRouter, internalRouter };
