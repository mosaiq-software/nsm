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
import { deployProject, teardownProject, updateDeploymentLog, planLocally, promoteDeployment, cancelDeploy, sweepStuckDestroyingInstances } from '@/controllers/deployController';
import { NSM_LABEL_SERVICE_INSTANCE_ID, NSM_LABEL_MANAGED, NSM_LABEL_PROJECT_ID } from '@/constants';
import { OpType, DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';
import { DeploymentState, DockerStatus, NginxConfigLocationType, Project } from '@mosaiq/nsm-common/types';
import { upsertProjectModel } from '@/persistence/projectPersistence';
import { upsertDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
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
        services: [{ serviceName: 'web', expectedContainerState: DockerStatus.RUNNING }],
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
    mockGetNode.mockReset().mockResolvedValue({ nodeId: 'n1', address: '10.0.0.2', apiPort: 5, lastSeen: 1, isLeader: false });
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
        // IP-less: proxy target is the assigned node's stable internal hostname, not its IP.
        expect(op.deployment.nginxConf).toContain('http://n1.nsm.internal:1025');
        expect(op.deployment.nginxConf).not.toContain('10.0.0.2');
        expect(op.deployment.compose).toContain(NSM_LABEL_SERVICE_INSTANCE_ID);
        expect(op.deployment.compose).toContain(NSM_LABEL_PROJECT_ID);
        expect(op.deployment.compose).toContain(NSM_LABEL_MANAGED);
    });
});

describe('deployProject zero-downtime', () => {
    it('defaults to zero-downtime: stamps the flag + ports and does NOT flip the active conf on the first deploy', async () => {
        mockGetProject.mockResolvedValue(baseProject());
        await deployProject('p1');
        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op.deployment.zeroDowntime).toBe(true);
        expect(op.deployment.ports).toEqual([{ proxyLocationId: 'lp', port: 1025, readinessPath: undefined }]);
        // First deploy: no previously-active generation, so nginx has nothing to serve until promotion.
        expect(op.deployment.activeGeneration).toBeUndefined();
        expect(op.deployment.activeNginxConf).toBeUndefined();
    });

    it('opt-out project cuts over immediately (active = pending) and is not blue-green', async () => {
        mockGetProject.mockResolvedValue(baseProject({ zeroDowntime: false } as Partial<Project>));
        await deployProject('p1');
        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op.deployment.zeroDowntime).toBe(false);
        expect(op.deployment.activeGeneration).toBe(1);
        expect(op.deployment.activeNginxConf).toBe(op.deployment.nginxConf);
        expect(op.deployment.activeDomains).toEqual(op.deployment.domains);
    });

    it('sanitizes the compose for coexistence: strips container_name + fixed host ports and logs warnings', async () => {
        mockGetProject.mockResolvedValue(
            baseProject({ dockerCompose: { services: { web: { image: 'x', container_name: 'fixed', ports: ['8080:3000'] } } } } as unknown as Partial<Project>)
        );
        const instanceId = await deployProject('p1');
        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op.deployment.compose).not.toContain('container_name');
        expect(op.deployment.compose).not.toContain('8080:3000');
        const log = (await getProjectInstanceByIdModel(instanceId!))?.deploymentLog || '';
        expect(log).toContain('[zero-downtime]');
        expect(log).toContain('container_name');
    });
});

describe('promoteDeployment', () => {
    it('promotes the pending conf to active for the ready generation and deactivates superseded instances', async () => {
        const desired: DesiredDeployment = {
            projectId: 'p1',
            generation: 2,
            assignedNodeId: 'n1',
            repoOwner: 'o',
            repoName: 'r',
            timeout: 1,
            logId: 'iCurrent',
            dotenv: '',
            compose: '',
            nginxConf: 'NEWCONF',
            domains: ['ex.com'],
            services: [],
            zeroDowntime: true,
            ports: [{ proxyLocationId: 'lp', port: 1025 }],
            activeGeneration: 1,
            activeNginxConf: 'OLDCONF',
            activeDomains: ['ex.com'],
        };
        await upsertDesiredDeploymentModel(desired);
        await createProjectInstanceModel({ id: 'iOld', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: 1, lastUpdated: 1, active: true, directories: {} });
        await createProjectInstanceModel({ id: 'iCurrent', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: 2, lastUpdated: 2, active: true, directories: {} });

        await promoteDeployment('p1', 2, 'n1');

        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op.deployment.activeGeneration).toBe(2);
        expect(op.deployment.activeNginxConf).toBe('NEWCONF');
        expect((await getProjectInstanceByIdModel('iOld'))?.active).toBe(false);
        expect((await getProjectInstanceByIdModel('iCurrent'))?.active).toBe(true);
    });

    it('ignores a stale ready report for a superseded generation', async () => {
        const desired: DesiredDeployment = {
            projectId: 'p1',
            generation: 5,
            assignedNodeId: 'n1',
            repoOwner: 'o',
            repoName: 'r',
            timeout: 1,
            logId: 'i5',
            dotenv: '',
            compose: '',
            nginxConf: 'C5',
            domains: [],
            services: [],
            zeroDowntime: true,
            ports: [],
            activeGeneration: 4,
        };
        await upsertDesiredDeploymentModel(desired);
        await promoteDeployment('p1', 3, 'n1'); // stale (current desired is gen 5)
        expect(proposedOps().some((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT)).toBe(false);
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

    it('marks active instances DESTROYED (terminal), inactive, and proposes CLEAR_DESIRED_DEPLOYMENT', async () => {
        await upsertProjectModel({ id: 'p1', state: DeploymentState.READY, repoOwner: 'o', repoName: 'r', deploymentKey: 'k', allowCICD: false, nginxConfigJson: '{"servers":[]}', dockerComposeJson: '{"services":{}}', servicesJson: '[]' });
        await createProjectInstanceModel({ id: 'i1', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        await teardownProject('p1');
        const inst = await getProjectInstanceByIdModel('i1');
        expect(inst?.active).toBe(false);
        expect(inst?.state).toBe(DeploymentState.DESTROYED);
        expect(proposedOps().some((o) => o.type === OpType.CLEAR_DESIRED_DEPLOYMENT)).toBe(true);
    });
});

describe('sweepStuckDestroyingInstances', () => {
    it('advances lingering DESTROYING instances to terminal DESTROYED (no-op otherwise)', async () => {
        await createProjectInstanceModel({ id: 'iStuck', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DESTROYING, created: 1, lastUpdated: 1, active: false, directories: {} });
        await createProjectInstanceModel({ id: 'iDone', projectId: 'p2', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: 1, lastUpdated: 1, active: true, directories: {} });

        await sweepStuckDestroyingInstances();

        expect((await getProjectInstanceByIdModel('iStuck'))?.state).toBe(DeploymentState.DESTROYED);
        expect((await getProjectInstanceByIdModel('iStuck'))?.active).toBe(false);
        expect((await getProjectInstanceByIdModel('iDone'))?.state).toBe(DeploymentState.DEPLOYED);
    });

    it('does nothing when not the leader', async () => {
        await createProjectInstanceModel({ id: 'iStuck', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DESTROYING, created: 1, lastUpdated: 1, active: false, directories: {} });
        isLeader.mockReturnValue(false);
        await sweepStuckDestroyingInstances();
        expect((await getProjectInstanceByIdModel('iStuck'))?.state).toBe(DeploymentState.DESTROYING);
    });
});

describe('cancelDeploy', () => {
    const desiredWith = (over: Partial<DesiredDeployment>): DesiredDeployment => ({
        projectId: 'p1',
        generation: 1,
        assignedNodeId: 'n1',
        repoOwner: 'o',
        repoName: 'r',
        timeout: 1,
        logId: 'iDep',
        dotenv: '',
        compose: '',
        nginxConf: 'NEW',
        domains: ['new.com'],
        services: [],
        zeroDowntime: true,
        ports: [],
        ...over,
    });

    it('throws when not the leader', async () => {
        isLeader.mockReturnValue(false);
        await expect(cancelDeploy('p1')).rejects.toThrow(/leader/);
    });

    it('rolls the desired state back to the previously-serving generation and cancels on the node', async () => {
        mockGetProject.mockResolvedValue(baseProject());
        await upsertDesiredDeploymentModel(desiredWith({ generation: 3, activeGeneration: 2, activeNginxConf: 'OLD', activeDomains: ['old.com'] }));
        await createProjectInstanceModel({ id: 'iDep', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: 1, lastUpdated: 1, active: true, directories: {} });

        await cancelDeploy('p1');

        const op = proposedOps().find((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT);
        expect(op.deployment.generation).toBe(2);
        expect(op.deployment.nginxConf).toBe('OLD');
        expect(op.deployment.domains).toEqual(['old.com']);
        expect(mockPostToNode).toHaveBeenCalledWith('10.0.0.2', 5, '/node/cancel-deploy', { projectId: 'p1' });
        expect((await getProjectInstanceByIdModel('iDep'))?.state).toBe(DeploymentState.CANCELLED);
    });

    it('clears the desired state for a first-ever deploy with nothing serving', async () => {
        mockGetProject.mockResolvedValue(baseProject());
        await upsertDesiredDeploymentModel(desiredWith({ generation: 1, activeGeneration: undefined }));
        await createProjectInstanceModel({ id: 'iDep', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: 1, lastUpdated: 1, active: true, directories: {} });

        await cancelDeploy('p1');

        expect(proposedOps().some((o) => o.type === OpType.CLEAR_DESIRED_DEPLOYMENT)).toBe(true);
        expect(proposedOps().some((o) => o.type === OpType.SET_DESIRED_DEPLOYMENT)).toBe(false);
        expect((await getProjectInstanceByIdModel('iDep'))?.state).toBe(DeploymentState.CANCELLED);
    });
});

describe('updateDeploymentLog + planLocally', () => {
    it('updates instance state and appends to the log', async () => {
        await createProjectInstanceModel({ id: 'i1', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        await updateDeploymentLog('i1', DeploymentState.DEPLOYED, 'done\n');
        const inst = await getProjectInstanceByIdModel('i1');
        expect(inst?.state).toBe(DeploymentState.DEPLOYED);
        expect(inst?.deploymentLog).toContain('done');
        // A successful deploy stays the active/serving instance.
        expect(inst?.active).toBe(true);
    });

    it('clears active when transitioning into a terminal failure state', async () => {
        await createProjectInstanceModel({ id: 'iFail', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        await updateDeploymentLog('iFail', DeploymentState.FAILED, 'boom\n');
        const inst = await getProjectInstanceByIdModel('iFail');
        expect(inst?.state).toBe(DeploymentState.FAILED);
        expect(inst?.active).toBe(false);
    });

    it('planLocally allocates ports only when proxies exist', async () => {
        const withProxies = await planLocally(2, { a: { relPath: '/a' } });
        expect(withProxies.ports).toEqual([1111]);
        expect(withProxies.dirs).toEqual({ d: { fullPath: '/x' } });
        const noProxies = await planLocally(0, {});
        expect(noProxies.ports).toEqual([]);
    });
});
