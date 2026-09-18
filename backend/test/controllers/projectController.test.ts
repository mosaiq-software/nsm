import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true, status: vi.fn() } }));
vi.mock('@/utils/repositoryUtils', () => ({ getRepoData: vi.fn(async () => ({ dotenv: '', compose: { exists: true, contents: '', parsed: { services: {} } }, jsEnvVars: [] })) }));
vi.mock('@/controllers/secretController', () => ({ applyRepoData: vi.fn(), getAllSecretsForProject: vi.fn(async () => []) }));
vi.mock('@/controllers/deployController', () => ({ teardownProject: vi.fn(), purgeProjectOnAssignedNode: vi.fn(), teardownProjectOnAssignedNode: vi.fn() }));
vi.mock('@/controllers/projectInstanceController', () => ({ deleteProjectInstancesForProject: vi.fn() }));
vi.mock('@/reconcile/nginxRender', () => ({ renderAllNginx: vi.fn() }));
vi.mock('@/reconcile/certs', () => ({ removeCertsForDomains: vi.fn() }));

import { cluster } from '@/cluster/node';
import { applyOp } from '@/cluster/stateMachine';
import { getAllSecretsForProject } from '@/controllers/secretController';
import { createProject, updateProject, resetDeploymentKey, setProjectAssignment, deleteProject, teardownProjectWithCleanup, verifyDeploymentKey, getProject } from '@/controllers/projectController';
import { teardownProject, purgeProjectOnAssignedNode, teardownProjectOnAssignedNode } from '@/controllers/deployController';
import { renderAllNginx } from '@/reconcile/nginxRender';
import { removeCertsForDomains } from '@/reconcile/certs';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { getProjectByIdModel } from '@/persistence/projectPersistence';
import { createProjectInstanceModel } from '@/persistence/projectInstancePersistence';

const propose = cluster.propose as unknown as Mock;
let idx = 0;

const seedProject = (over: Partial<Project> = {}) => applyOp({ type: OpType.UPSERT_PROJECT, project: { id: 'p1', repoOwner: 'o', repoName: 'r', state: DeploymentState.READY, deploymentKey: 'origkey', allowCICD: false, ...over } }, ++idx);

const proposedOps = () => propose.mock.calls.map((c) => c[0]);

beforeEach(async () => {
    await resetDb();
    idx = 0;
    propose.mockReset();
    propose.mockImplementation(async (op: any) => {
        await applyOp(op, ++idx);
    });
});

describe('projectController writes', () => {
    it('createProject proposes an upsert with a generated 32-char key', async () => {
        const result = await createProject({ id: 'p1', repoOwner: 'o', repoName: 'r' } as Project);
        const op = proposedOps().find((o) => o.type === OpType.UPSERT_PROJECT);
        expect(op.project.deploymentKey).toHaveLength(32);
        expect(op.project.state).toBe(DeploymentState.READY);
        expect(result?.id).toBe('p1');
        expect(await getProjectByIdModel('p1')).toBeTruthy();
    });

    it('updateProject merges, flips dirtyConfig, and strips instances', async () => {
        await seedProject();
        await updateProject('p1', { repoName: 'renamed', instances: [{ id: 'x' }] } as any);
        const op = proposedOps().at(-1);
        expect(op.project.repoName).toBe('renamed');
        expect(op.project.dirtyConfig).toBe(true);
        expect(op.project).not.toHaveProperty('instances');
        expect((await getProjectByIdModel('p1'))?.repoName).toBe('renamed');
    });

    it('resetDeploymentKey rotates the key without dirtying config', async () => {
        await seedProject();
        const key = await resetDeploymentKey('p1');
        expect(key).toHaveLength(32);
        expect((await getProjectByIdModel('p1'))?.deploymentKey).toBe(key);
        expect((await getProjectByIdModel('p1'))?.dirtyConfig).toBeFalsy();
    });

    it('setProjectAssignment proposes SET_PROJECT_ASSIGNMENT', async () => {
        await seedProject();
        await setProjectAssignment('p1', 'nodeX');
        expect((await getProjectByIdModel('p1'))?.workerNodeId).toBe('nodeX');
    });

    it('deleteProject purges the node, tears down, removes certs, then proposes DELETE_PROJECT', async () => {
        await seedProject({ nginxConfig: { servers: [{ serverId: 's', domain: 'd.com', wildcardSubdomain: false, locations: [] }] } } as any);
        const ok = await deleteProject('p1');
        expect(ok).toBe(true);
        expect(purgeProjectOnAssignedNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
        expect(teardownProject).toHaveBeenCalledWith('p1');
        expect(renderAllNginx).toHaveBeenCalled();
        expect(removeCertsForDomains).toHaveBeenCalledWith(['d.com']);
        expect(proposedOps().some((o) => o.type === OpType.DELETE_PROJECT)).toBe(true);
        expect(await getProjectByIdModel('p1')).toBeUndefined();
    });

    it('teardownProjectWithCleanup tears down the node (no archive), removes certs, and keeps the project', async () => {
        (purgeProjectOnAssignedNode as unknown as Mock).mockClear();
        await seedProject({ nginxConfig: { servers: [{ serverId: 's', domain: 'd.com', wildcardSubdomain: false, locations: [] }] } } as any);
        await teardownProjectWithCleanup('p1');
        expect(teardownProjectOnAssignedNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
        expect(purgeProjectOnAssignedNode).not.toHaveBeenCalled();
        expect(teardownProject).toHaveBeenCalledWith('p1');
        expect(renderAllNginx).toHaveBeenCalled();
        expect(removeCertsForDomains).toHaveBeenCalledWith(['d.com']);
        expect(proposedOps().some((o) => o.type === OpType.DELETE_PROJECT)).toBe(false);
        expect(await getProjectByIdModel('p1')).toBeTruthy();
    });
});

describe('verifyDeploymentKey', () => {
    it('gates CICD deploys on allowCICD but always allows web deploys with the right key', async () => {
        await seedProject({ deploymentKey: 'k', allowCICD: false });
        expect(await verifyDeploymentKey('p1', 'k', true)).toBe(true);
        expect(await verifyDeploymentKey('p1', 'k', false)).toBe(false); // CICD disabled
        expect(await verifyDeploymentKey('p1', 'wrong', true)).toBe(false);
        await seedProject({ deploymentKey: 'k', allowCICD: true });
        expect(await verifyDeploymentKey('p1', 'k', false)).toBe(true);
    });
});

describe('getProject assembly', () => {
    it('assembles secrets, instance headers and parsed config', async () => {
        await seedProject({ nginxConfig: { servers: [{ serverId: 's', domain: 'd', wildcardSubdomain: false, locations: [] }] } } as any);
        (getAllSecretsForProject as unknown as Mock).mockResolvedValueOnce([{ projectId: 'p1', secretName: 'A', secretValue: '1', secretPlaceholder: '', variable: false }]);
        await createProjectInstanceModel({ id: 'i1', projectId: 'p1', workerNodeId: 'n1', state: DeploymentState.DEPLOYED, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });
        const project = await getProject('p1');
        expect(project?.instances).toHaveLength(1);
        expect(project?.secrets?.[0].secretName).toBe('A');
        expect(project?.nginxConfig.servers[0].domain).toBe('d');
    });
});
