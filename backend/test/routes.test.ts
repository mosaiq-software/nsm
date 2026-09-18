import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, Mock } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// --- Mock every dependency the router wires in, so we test HTTP behavior in isolation. ---
vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true), leaderAddress: vi.fn(() => 'http://leader:1'), propose: vi.fn(), status: vi.fn(), members: vi.fn(() => []) } }));
vi.mock('@/cluster/leaderClient', () => ({ CLUSTER_SECRET_HEADER: 'x-nsm-cluster-secret', forwardToLeader: vi.fn((_req: any, res: any) => res.status(599).send('forwarded')) }));
vi.mock('@/cluster/statusGossip', () => ({ ingestReport: vi.fn() }));
vi.mock('@/cluster/registry', () => ({ registerNode: vi.fn(async () => undefined), deregisterNode: vi.fn(async () => undefined), getRegistry: vi.fn(async () => ({ nodes: [] })) }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getDesiredDeploymentsAssignedToModel: vi.fn(async () => []) }));
vi.mock('@/controllers/observabilityController', () => ({ queryLogs: vi.fn(async () => ({ lines: [] })), queryMetric: vi.fn(async () => ({ metric: 'cpu', series: [] })), queryNsmLogs: vi.fn(async () => ({ lines: [] })), queryStructuredLogs: vi.fn(async () => ({ entries: [] })), queryLogFacets: vi.fn(async () => ({ facets: [], total: 0 })) }));
vi.mock('@/cluster/selfUpdate', () => ({ applyUpdateInstruction: vi.fn(), setDesiredNsmVersion: vi.fn() }));
vi.mock('@/controllers/userController', () => ({ verifyAuthToken: vi.fn(async () => true), signInUser: vi.fn(), signOutUser: vi.fn() }));
vi.mock('@/controllers/projectController', () => ({ getProject: vi.fn(async () => ({ id: 'p1' })), getAllProjects: vi.fn(async () => []), verifyDeploymentKey: vi.fn(async () => true), createProject: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), teardownProjectWithCleanup: vi.fn(), resetDeploymentKey: vi.fn(), setProjectAssignment: vi.fn(), syncProjectToRepoData: vi.fn() }));
vi.mock('@/controllers/deployController', () => ({ deployProject: vi.fn(async () => 'log1'), planLocally: vi.fn(async () => ({ ports: [1], dirs: {} })), updateDeploymentLog: vi.fn() }));
vi.mock('@/controllers/deployQueue', () => ({ enqueueDeploy: vi.fn(async () => 'log1') }));
vi.mock('@/controllers/secretController', () => ({ updateEnvironmentVariable: vi.fn() }));
vi.mock('@/controllers/projectInstanceController', () => ({ getProjectInstance: vi.fn() }));
vi.mock('@/controllers/statusController', () => ({ getControlPlaneStatus: vi.fn(async () => ({})) }));
vi.mock('@/controllers/authz', () => ({
    getRequestUser: vi.fn(async () => ({ name: 'u', githubId: 'g', authToken: 'good', avatarUrl: '', created: 0, signedIn: true })),
    getEffectiveCapabilitiesForProject: vi.fn(async () => ['view', 'deploy', 'configure', 'delete']),
    requireAdmin: vi.fn(async () => true),
    requireSuperAdmin: vi.fn(async () => true),
    requireProjectCapability: vi.fn(async () => true),
    requireCreateProjectForOwner: vi.fn(async () => true),
    requireOwnerInstalledForProject: vi.fn(async () => true),
    requireTeamManage: vi.fn(async () => true),
}));
vi.mock('@/controllers/teamController', () => ({ buildMeResponse: vi.fn(async () => ({ user: {}, isSuperAdmin: false, isAdmin: false, teams: [] })), getVisibleProjects: vi.fn(async () => []), redactProjectSecrets: vi.fn((p: any) => p), listAllTeams: vi.fn(async () => []), getTeamDetail: vi.fn(async () => null), setTeamDefaults: vi.fn(), setTeamOverride: vi.fn(), clearTeamOverride: vi.fn() }));
vi.mock('@/controllers/adminController', () => ({ getAdmins: vi.fn(async () => ({ admins: [], superAdminLogin: null })), addAdmin: vi.fn(async () => ({ id: '1', login: 'x', avatarUrl: '' })), removeAdmin: vi.fn() }));
vi.mock('@/utils/authUtils', () => ({ getGithubAuthTokenFromTempCode: vi.fn() }));
vi.mock('@/persistence/nodePersistence', () => ({ getAllNodesModel: vi.fn(async () => []) }));

import { initApp } from '@/app';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { forwardToLeader } from '@/cluster/leaderClient';
import { verifyAuthToken } from '@/controllers/userController';
import { verifyDeploymentKey } from '@/controllers/projectController';
import { setTeamDefaults } from '@/controllers/teamController';
import { ingestReport } from '@/cluster/statusGossip';
import { enqueueDeploy } from '@/controllers/deployQueue';
import { queryNsmLogs } from '@/controllers/observabilityController';

const SECRET = 'x-nsm-cluster-secret';
const isLeader = cluster.isLeader as unknown as Mock;
const mForward = forwardToLeader as unknown as Mock;
const mVerifyAuth = verifyAuthToken as unknown as Mock;
const mVerifyKey = verifyDeploymentKey as unknown as Mock;

let app: Express;
beforeAll(async () => {
    app = await initApp();
});
beforeEach(() => {
    isLeader.mockReturnValue(true);
    mForward.mockClear();
    mVerifyAuth.mockResolvedValue(true);
    mVerifyKey.mockResolvedValue(true);
});
afterEach(() => {
    config.production = false;
});

describe('public routes', () => {
    it('GET /healthz returns 200 with node info', async () => {
        const res = await request(app).get('/healthz');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });
});

describe('private auth middleware', () => {
    it('401 without an auth header', async () => {
        expect((await request(app).get('/project/p1')).status).toBe(401);
    });
    it('403 with an invalid token', async () => {
        mVerifyAuth.mockResolvedValue(false);
        expect((await request(app).get('/project/p1').set('authorization', 'bad')).status).toBe(403);
    });
    it('200 with a valid token', async () => {
        const res = await request(app).get('/project/p1').set('authorization', 'good');
        expect(res.status).toBe(200);
        expect(res.body.id).toBe('p1');
    });
});

describe('requireLeader forwarding', () => {
    it('forwards a private write to the leader when this node is a follower', async () => {
        isLeader.mockReturnValue(false);
        const res = await request(app).post('/team/o1/defaults').set('authorization', 'good').send({ capabilities: [] });
        expect(res.status).toBe(599);
        expect(mForward).toHaveBeenCalled();
    });
    it('runs the controller locally when this node is the leader', async () => {
        const res = await request(app).post('/team/o1/defaults').set('authorization', 'good').send({ capabilities: [] });
        expect(res.status).toBe(200);
        expect(setTeamDefaults).toHaveBeenCalledWith('o1', []);
    });
});

describe('nsm logs route', () => {
    it('runs queryNsmLogs on the leader with the node filter and time range', async () => {
        const res = await request(app).get('/observability/nsm-logs?nodeId=node-a&start=0&end=9&limit=100').set('authorization', 'good');
        expect(res.status).toBe(200);
        expect(queryNsmLogs).toHaveBeenCalledWith('node-a', '0', '9', 100);
    });
    it('is leader-gated (follower forwards)', async () => {
        isLeader.mockReturnValue(false);
        const res = await request(app).get('/observability/nsm-logs').set('authorization', 'good');
        expect(res.status).toBe(599);
        expect(mForward).toHaveBeenCalled();
    });
});

describe('structured log query routes', () => {
    it('POST /observability/query runs on the leader', async () => {
        const res = await request(app).post('/observability/query').set('authorization', 'good').send({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ entries: [] });
    });
    it('POST /observability/query 400s without a selector', async () => {
        const res = await request(app).post('/observability/query').set('authorization', 'good').send({ startNs: '0', endNs: '9' });
        expect(res.status).toBe(400);
    });
    it('POST /observability/facets is leader-gated (follower forwards)', async () => {
        isLeader.mockReturnValue(false);
        const res = await request(app).post('/observability/facets').set('authorization', 'good').send({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9', fields: ['area'] });
        expect(res.status).toBe(599);
        expect(mForward).toHaveBeenCalled();
    });
});

describe('deploy webhook gate', () => {
    it('403 on an invalid deployment key', async () => {
        mVerifyKey.mockResolvedValue(false);
        expect((await request(app).get('/deploy/p1/KEY')).status).toBe(403);
    });
    it('200 and triggers deploy on a valid key (leader)', async () => {
        const res = await request(app).get('/deploy/p1/KEY');
        expect(res.status).toBe(200);
        expect(enqueueDeploy).toHaveBeenCalledWith('p1');
    });
});

describe('internal cluster-secret routes', () => {
    it('403 without the cluster secret', async () => {
        expect((await request(app).post('/cluster/status-report').send({})).status).toBe(403);
    });
    it('200 with the cluster secret (leader ingests)', async () => {
        const res = await request(app).post('/cluster/status-report').set(SECRET, config.clusterSecret).send({ nodeId: 'n1', containers: [] });
        expect(res.status).toBe(200);
        expect(ingestReport).toHaveBeenCalled();
    });
    it('/node/plan runs without a leader gate', async () => {
        const res = await request(app).post('/node/plan').set(SECRET, config.clusterSecret).send({ proxyCount: 1, dirs: {} });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ports: [1], dirs: {} });
    });
    it('/cluster/register is leader-gated (follower forwards)', async () => {
        isLeader.mockReturnValue(false);
        const res = await request(app).post('/cluster/register').set(SECRET, config.clusterSecret).send({ nodeId: 'n1', address: '1.1.1.1', apiPort: 1025 });
        expect(res.status).toBe(599);
    });
    it('/cluster/register returns the registry snapshot on the leader', async () => {
        const res = await request(app).post('/cluster/register').set(SECRET, config.clusterSecret).send({ nodeId: 'n1', address: '1.1.1.1', apiPort: 1025 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ nodes: [] });
    });
    it('/node/desired returns assigned deployments + registry on the leader', async () => {
        const res = await request(app).post('/node/desired').set(SECRET, config.clusterSecret).send({ nodeId: 'n1' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deployments: [], registry: [] });
    });
});

describe('dev endpoints', () => {
    it('404 in production', async () => {
        config.production = true;
        const res = await request(app).post('/cluster/dev-propose').set(SECRET, config.clusterSecret).send({ type: 'x' });
        expect(res.status).toBe(404);
    });
    it('available (leader) in non-production', async () => {
        const res = await request(app).post('/cluster/dev-propose').set(SECRET, config.clusterSecret).send({ type: 'x' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });
});
