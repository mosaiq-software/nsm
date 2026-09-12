import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { API_BODY, API_PARAMS, API_RETURN, API_ROUTES } from '@mosaiq/nsm-common/routes';
import { NodeStatusReport } from '@mosaiq/nsm-common/types';
import { createProject, deleteProject, getAllProjects, getProject, resetDeploymentKey, setProjectAssignment, syncProjectToRepoData, updateProject, verifyDeploymentKey } from '@/controllers/projectController';
import { planLocally, teardownProject, updateDeploymentLog, promoteDeployment } from '@/controllers/deployController';
import { enqueueDeploy } from '@/controllers/deployQueue';
import { updateEnvironmentVariable } from '@/controllers/secretController';
import { getProjectInstance } from '@/controllers/projectInstanceController';
import { getControlPlaneStatus } from '@/controllers/statusController';
import { queryLogs, queryMetric, MetricKind } from '@/controllers/observabilityController';
import { getGithubAuthTokenFromTempCode } from '@/utils/authUtils';
import { signInUser, signOutUser, verifyAuthToken } from '@/controllers/userController';
import { getAllowedEntities, setAllowedEntities } from '@/controllers/allowedEntityController';
import { getVapidPublicKey, regenerateVapidKeys, subscribe, unsubscribe } from '@/controllers/pushController';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { config, gitSshKeyPath, isGithubAppConfigured } from '@/config';
import { mintInstallationToken, listInstallationOwners, listInstallationRepos, listRepoBranches } from '@/utils/githubApp';
import { cluster } from '@/cluster/node';
import { CLUSTER_SECRET_HEADER, forwardToLeader } from '@/cluster/leaderClient';
import { ingestReport } from '@/cluster/statusGossip';
import { registerNode, deregisterNode, getRegistry } from '@/cluster/registry';
import { getDesiredDeploymentsAssignedToModel } from '@/persistence/desiredDeploymentPersistence';
import { applyUpdateInstruction, setDesiredNsmVersion } from '@/cluster/selfUpdate';
import { registry } from '@/utils/metrics';

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
            console.error(`Refusing to serve install.sh: config.publicUrl is not a valid URL: ${config.publicUrl}`);
            return void res.status(500).send('server misconfigured');
        }
        const script = await fs.promises.readFile(path.join(config.nsmRepoDir, 'install.sh'), 'utf-8');
        const templated = script.replace('NSM_LEADER_DEFAULT="${NSM_LEADER_DEFAULT:-}"', () => `NSM_LEADER_DEFAULT="${base}"`);
        res.setHeader('Content-Type', 'text/x-shellscript');
        res.status(200).send(templated);
    } catch (e) {
        console.error('Error serving install.sh', e);
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
        console.error(error);
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
        await enqueueDeploy(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        console.error('Error deploying (webhook)', e);
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
        console.error('Error with GitHub login', e);
        res.status(500).send();
    }
});

// === Private (user-authenticated) reads ===
privateRouter.get(API_ROUTES.GET_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_PROJECT];
    const project = await getProject(params.projectId);
    if (!project) return void res.status(404).send('Project not found');
    res.status(200).json(project);
});

privateRouter.get(API_ROUTES.GET_PROJECTS, async (_req, res) => {
    try {
        res.status(200).json(await getAllProjects());
    } catch (e) {
        console.error('Error listing projects', e);
        res.status(500).send();
    }
});

privateRouter.get(API_ROUTES.GET_PROJECT_INSTANCE, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_PROJECT_INSTANCE];
    const instance = await getProjectInstance(params.projectInstanceId);
    if (!instance) return void res.status(404).send('Project instance not found');
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
        console.error(`Cannot build join command: config.publicUrl is not a valid URL: ${config.publicUrl}`);
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

privateRouter.get(API_ROUTES.GET_ALLOWED_ENTITIES, async (_req, res) => {
    res.status(200).json(await getAllowedEntities());
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

// GitHub App-backed suggestions for the create-project form. Leader-only (only the leader holds the
// App private key). These degrade to an empty list on any failure so the form's free-text entry
// still works when the App isn't configured or GitHub is unreachable.
privateRouter.get(API_ROUTES.GET_GITHUB_OWNERS, async (req, res) => {
    if (!requireLeader(req, res)) return;
    if (!isGithubAppConfigured()) return void res.status(200).json([]);
    try {
        res.status(200).json(await listInstallationOwners());
    } catch (e) {
        console.error('Error listing GitHub App owners', e);
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
        console.error(`Error listing GitHub repos for ${owner}`, e);
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
        console.error(`Error listing GitHub branches for ${owner}/${repo}`, e);
        res.status(200).json([]);
    }
});

privateRouter.get(API_ROUTES.GET_DEPLOY_WEB, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.GET_DEPLOY_WEB];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!(await verifyDeploymentKey(params.projectId, params.key, true))) return void res.status(403).send('Forbidden');
        if (!requireLeader(req, res)) return;
        const logId = await enqueueDeploy(params.projectId);
        res.status(200).json(logId);
    } catch (e) {
        console.error('Error deploying (web)', e);
        res.status(500).send();
    }
});

// === Private writes (forwarded to leader when needed) ===
privateRouter.post(API_ROUTES.POST_CREATE_PROJECT, async (req, res) => {
    const body = req.body as API_BODY[API_ROUTES.POST_CREATE_PROJECT];
    try {
        if (!body || !body.id || !body.repoOwner || !body.repoName) return void res.status(400).send('Invalid request body');
        if (!requireLeader(req, res)) return;
        res.status(200).json(await createProject(body));
    } catch (e) {
        console.error('Error creating project', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_UPDATE_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_UPDATE_PROJECT];
    const body = req.body as API_BODY[API_ROUTES.POST_UPDATE_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        await updateProject(params.projectId, body);
        res.status(200).json(undefined);
    } catch (e) {
        console.error('Error updating project', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_DELETE_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_DELETE_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        await deleteProject(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        console.error('Error deleting project', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_RESET_DEPLOYMENT_KEY];
    try {
        if (!requireLeader(req, res)) return;
        const newKey = await resetDeploymentKey(params.projectId);
        if (!newKey) return void res.status(404).send('Project not found');
        res.status(200).json(newKey);
    } catch (e) {
        console.error('Error resetting deployment key', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_UPDATE_ENV_VAR, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_UPDATE_ENV_VAR];
    const body = req.body as API_BODY[API_ROUTES.POST_UPDATE_ENV_VAR];
    try {
        if (!params.projectId || !body.secretName) return void res.status(400).send('Invalid request');
        if (!requireLeader(req, res)) return;
        await updateEnvironmentVariable(params.projectId, body);
        res.status(200).send('Environment variable updated');
    } catch (e) {
        console.error('Error updating environment variable', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SYNC_TO_REPO, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SYNC_TO_REPO];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        const project = await syncProjectToRepoData(params.projectId);
        if (!project) return void res.status(404).send('Project not found');
        res.status(200).json(project);
    } catch (e) {
        console.error('Error syncing project to repo data', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_TEARDOWN_PROJECT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_TEARDOWN_PROJECT];
    try {
        if (!params.projectId) return void res.status(400).send('No projectId');
        if (!requireLeader(req, res)) return;
        await teardownProject(params.projectId);
        res.status(200).json(undefined);
    } catch (e) {
        console.error('Error tearing down project', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SET_PROJECT_ASSIGNMENT, async (req, res) => {
    const params = req.params as API_PARAMS[API_ROUTES.POST_SET_PROJECT_ASSIGNMENT];
    const body = req.body as API_BODY[API_ROUTES.POST_SET_PROJECT_ASSIGNMENT];
    try {
        if (!params.projectId || !body.nodeId) return void res.status(400).send('Invalid request');
        if (!requireLeader(req, res)) return;
        await setProjectAssignment(params.projectId, body.nodeId);
        res.status(200).json(undefined);
    } catch (e) {
        console.error('Error assigning project', e);
        res.status(500).send();
    }
});

privateRouter.post(API_ROUTES.POST_SET_ALLOWED_ENTITIES, async (req, res) => {
    const body = req.body as API_BODY[API_ROUTES.POST_SET_ALLOWED_ENTITIES];
    try {
        if (!body || !body.entities) return void res.status(400).send('Invalid request body');
        if (!requireLeader(req, res)) return;
        await setAllowedEntities(body.entities);
        res.status(200).send('Allowed entities set');
    } catch (e) {
        console.error('Error setting allowed entities', e);
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
        console.error('Error with GitHub logout', e);
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
        console.error('Error regenerating VAPID keys', e);
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
        console.error('Error saving push subscription', e);
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
        console.error('Error removing push subscription', e);
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
    tar.stderr.on('data', (d) => console.error('[bundle] tar:', d.toString()));
    tar.on('error', (e) => {
        console.error('[bundle] failed to spawn tar', e);
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
        console.error(`Failed to mint git token for ${repoOwner}/${repoName}:`, e?.message || e);
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
        console.error('Error reading deploy key', e);
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
