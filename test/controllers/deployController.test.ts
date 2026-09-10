import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: vi.fn(() => true), propose: vi.fn(), status: vi.fn() } }));
vi.mock('@/controllers/projectController', () => ({ getProject: vi.fn(), syncProjectToRepoData: vi.fn() }));
vi.mock('@/persistence/nodePersistence', () => ({ getNodeByIdModel: vi.fn() }));
vi.mock('@/cluster/leaderClient', () => ({ postToNode: vi.fn() }));
vi.mock('@/reconcile/certs', () => ({ leaderEnsureCerts: vi.fn() }));
vi.mock('@/reconcile/ports', () => ({ getNextFreePorts: vi.fn(async () => [1111]) }));
vi.mock('@/reconcile/directories', () => ({ ensureDirectories: vi.fn(async () => ({ d: { fullPath: '/x' } })) }));

import { cluster } from '@/cluster/node';
import { getProject, syncProjectToRepoData } from '@/controllers/projectController';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { postToNode } from '@/cluster/leaderClient';
import { deployProject, teardownProject, updateDeploymentLog, planLocally } from '@/controllers/deployController';
import { NSM_LABEL_SERVICE_INSTANCE_ID } from '@/constants';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { DeploymentState, DockerStatus, NginxConfigLocationType, Project } from '@mosaiq/nsm-common/types';
import { upsertProjectModel } from '@/persistence/projectPersistence';
import { createProjectInstanceModel, getProjectInstanceByIdModel } from '@/persistence/projectInstancePersistence';

const isLeader = cluster.isLeader as unknown as Mock;
const propose = cluster.propose as unknown as Mock;
const mockGetProject = getProject as unknown as Mock;
const mockSync = syncProjectToRepoData as unknown as Mock;
const mockGetNode = getNodeByIdModel as unknown as Mock;
const mockPostToNode = postToNode as unknown as Mock;

const baseProject = (over: Partial<Project> = {}): Project =>
    ({
        id: 'p1',
        repoOwner: 'o',
        repoName: 'r',
        workerNodeId: 'n1',
        state: DeploymentState.READY,
        deploymentKey: 'k',
        allowCICD: false,
        hasDockerCompose: true,
        hasDotenv: false,
        secrets: [],
        services: [{ serviceName: 'web', expectedContainerState: DockerStatus.RUNNING, collectContainerLogs: false }],
        dockerCompose: { services: { web: { image: 'x' } } },
        nginxConfig: { servers: [{ serverId: 's1', domain: 'ex.com', wildcardSubdomain: false, locations: [{ locationId: 'lp', type: NginxConfigLocationType.PROXY, path: '/api', proxyPass: '', websocketSupport: false }] }] },
        ...over,
    } as unknown as Project);

const proposedOps = () => propose.mock.calls.map((c) => c[0]);

beforeEach(async () => {
    await resetDb();
    isLeader.mockReturnValue(true);
    propose.mockReset();
    mockGetProject.mockReset();
    mockSync.mockReset();
    mockGetNode.mockReset().mockResolvedValue({ nodeId: 'n1', address: '10.0.0.2', apiPort: 5, raftPort: 6, voter: true });
    mockPostToNode.mockReset().mockResolvedValue({ ports: [1025], dirs: {} });
});

describe('deployProject happy path', () => {
    it('builds and proposes a DesiredDeployment with proxy pass, domains, and injected labels', async () => {
        mockGetProject.mockResolvedValue(baseProject());
        const instanceId = await deployProject('p1');
        expect(instanceId).toBeTruthy();
        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op).toBeTruthy();
        expect(op.deployment.generation).toBe(1);
        expect(op.deployment.assignedNodeId).toBe('n1');
        expect(op.deployment.domains).toEqual(['ex.com']);
        expect(op.deployment.nginxConf).toContain('http://10.0.0.2:1025');
        expect(op.deployment.compose).toContain(NSM_LABEL_SERVICE_INSTANCE_ID);
    });
});

describe('deployProject guards', () => {
    it('throws when not the leader', async () => {
        isLeader.mockReturnValue(false);
        await expect(deployProject('p1')).rejects.toThrow(/leader/);
    });

    it('returns undefined and proposes nothing when the project is missing', async () => {
        mockGetProject.mockResolvedValue(undefined);
        expect(await deployProject('p1')).toBeUndefined();
        expect(proposedOps().some((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT)).toBe(false);
    });

    it('fails the instance when config drifts after sync', async () => {
        mockGetProject.mockResolvedValueOnce(baseProject());
        mockGetProject.mockResolvedValueOnce(baseProject({ nginxConfig: { servers: [] } } as any));
        const instanceId = await deployProject('p1');
        expect(proposedOps().some((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT)).toBe(false);
        expect((await getProjectInstanceByIdModel(instanceId!))?.state).toBe(DeploymentState.FAILED);
    });

    it('fails the instance when the repo has no compose file', async () => {
        mockGetProject.mockResolvedValue(baseProject({ hasDockerCompose: false }));
        const instanceId = await deployProject('p1');
        expect(proposedOps().some((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT)).toBe(false);
        expect((await getProjectInstanceByIdModel(instanceId!))?.state).toBe(DeploymentState.FAILED);
    });
});

describe('teardownProject', () => {
    it('throws when not the leader', async () => {
        isLeader.mockReturnValue(false);
        await expect(teardownProject('p1')).rejects.toThrow(/leader/);
    });

    it('marks active instances inactive and proposes CLEAR_DESIRED_DEPLOYMENT', async () => {
        await upsertProjectModel({ id: 'p1', state: DeploymentState.READY, repoOwner: 'o', repoName: 'r', deploymentKey: 'k', allowCICD: false, nginxConfigJson: '{"servers":[]}', dockerComposeJson: '{"services":{}}', servicesJson: '[]' });
        await createProjectInstanceModel({ id: 'i1', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        await teardownProject('p1');
        expect((await getProjectInstanceByIdModel('i1'))?.active).toBe(false);
        expect(proposedOps().some((o) => o.type === OpType.CLEAR_DESIRED_DEPLOYMENT)).toBe(true);
    });
});

describe('updateDeploymentLog + planLocally', () => {
    it('updates instance state and appends to the log', async () => {
        await createProjectInstanceModel({ id: 'i1', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        await updateDeploymentLog('i1', DeploymentState.DEPLOYED, 'done\n');
        const inst = await getProjectInstanceByIdModel('i1');
        expect(inst?.state).toBe(DeploymentState.DEPLOYED);
        expect(inst?.deploymentLog).toContain('done');
    });

    it('planLocally allocates ports only when proxies exist', async () => {
        const withProxies = await planLocally(2, { a: { relPath: '/a' } });
        expect(withProxies.ports).toEqual([1111]);
        expect(withProxies.dirs).toEqual({ d: { fullPath: '/x' } });
        const noProxies = await planLocally(0, {});
        expect(noProxies.ports).toEqual([]);
    });
});
