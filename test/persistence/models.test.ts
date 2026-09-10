import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { ProjectModelType, createProjectModel, deleteProjectModel, getAllProjectsModel, getProjectByIdModel, updateProjectModelNoDirty, upsertProjectModel } from '@/persistence/projectPersistence';
import { createSecretModel, deleteAllSecretsForProjectEnvModel, getAllSecretsForProjectModel, updateSecretModel, upsertSecretModel } from '@/persistence/secretPersistence';
import { deleteNodeModel, getAllNodesModel, getNodeByIdModel, upsertNodeModel } from '@/persistence/nodePersistence';
import { getAllCertsModel, getCertModel, upsertCertModel } from '@/persistence/certPersistence';
import { getDesiredNsmVersion, getLastAppliedIndex, getMeta, setDesiredNsmVersion, setLastAppliedIndex, setMeta } from '@/persistence/clusterMetaPersistence';
import { getAllDesiredDeploymentsModel, getDesiredDeploymentModel, getDesiredDeploymentsAssignedToModel, deleteDesiredDeploymentModel, upsertDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { DeploymentState, Secret } from '@mosaiq/nsm-common/types';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';

beforeEach(async () => resetDb());

const projectRow = (id: string, over: Partial<ProjectModelType> = {}): ProjectModelType => ({
    id,
    state: DeploymentState.READY,
    repoOwner: 'o',
    repoName: 'r',
    deploymentKey: 'k',
    allowCICD: false,
    nginxConfigJson: JSON.stringify({ servers: [] }),
    dockerComposeJson: JSON.stringify({ services: {} }),
    servicesJson: JSON.stringify([]),
    ...over,
});

describe('projectPersistence', () => {
    it('creates, reads, updates and deletes', async () => {
        await createProjectModel('p1', projectRow('p1'));
        expect((await getProjectByIdModel('p1'))?.repoOwner).toBe('o');
        await updateProjectModelNoDirty('p1', { repoOwner: 'o2', dirtyConfig: true });
        expect((await getProjectByIdModel('p1'))?.repoOwner).toBe('o2');
        expect(await getAllProjectsModel()).toHaveLength(1);
        await deleteProjectModel('p1');
        expect(await getProjectByIdModel('p1')).toBeUndefined();
    });

    it('upserts (insert then replace)', async () => {
        await upsertProjectModel(projectRow('p2', { repoName: 'first' }));
        await upsertProjectModel(projectRow('p2', { repoName: 'second' }));
        expect((await getProjectByIdModel('p2'))?.repoName).toBe('second');
        expect(await getAllProjectsModel()).toHaveLength(1);
    });
});

describe('secretPersistence', () => {
    const sec = (name: string, value = ''): Secret => ({ projectId: 'p1', secretName: name, secretValue: value, secretPlaceholder: '', variable: false });

    it('creates and updates by composite key', async () => {
        await createSecretModel(sec('A', '1'));
        await updateSecretModel('p1', { ...sec('A'), secretValue: '2' });
        const all = await getAllSecretsForProjectModel('p1');
        expect(all).toHaveLength(1);
        expect(all[0].secretValue).toBe('2');
    });

    it('upserts and bulk-deletes by project', async () => {
        await upsertSecretModel(sec('A', '1'));
        await upsertSecretModel(sec('A', '9')); // update, not duplicate
        await upsertSecretModel(sec('B', '2'));
        expect(await getAllSecretsForProjectModel('p1')).toHaveLength(2);
        await deleteAllSecretsForProjectEnvModel('p1');
        expect(await getAllSecretsForProjectModel('p1')).toHaveLength(0);
    });
});

describe('nodePersistence', () => {
    it('upserts, lists and deletes cluster nodes', async () => {
        await upsertNodeModel({ nodeId: 'n1', address: '1.1.1.1', raftPort: 1, apiPort: 2, voter: true });
        await upsertNodeModel({ nodeId: 'n1', address: '2.2.2.2', raftPort: 1, apiPort: 2, voter: true });
        expect((await getNodeByIdModel('n1'))?.address).toBe('2.2.2.2');
        expect(await getAllNodesModel()).toHaveLength(1);
        await deleteNodeModel('n1');
        expect(await getNodeByIdModel('n1')).toBeFalsy();
    });
});

describe('certPersistence', () => {
    it('upserts and reads cert material', async () => {
        await upsertCertModel({ domain: 'a.com', fullchainPem: 'FC', privkeyPem: 'PK', notAfter: 123 });
        await upsertCertModel({ domain: 'a.com', fullchainPem: 'FC2', privkeyPem: 'PK', notAfter: 456 });
        expect((await getCertModel('a.com'))?.fullchainPem).toBe('FC2');
        expect(await getAllCertsModel()).toHaveLength(1);
    });
});

describe('clusterMetaPersistence', () => {
    it('stores generic key/values', async () => {
        expect(await getMeta('missing')).toBeNull();
        await setMeta('k', 'v');
        await setMeta('k', 'v2');
        expect(await getMeta('k')).toBe('v2');
    });

    it('tracks last applied index and desired version', async () => {
        expect(await getLastAppliedIndex()).toBe(0);
        await setLastAppliedIndex(42);
        expect(await getLastAppliedIndex()).toBe(42);
        expect(await getDesiredNsmVersion()).toBeNull();
        await setDesiredNsmVersion('1.2.3', 'v1.2.3');
        expect(await getDesiredNsmVersion()).toEqual({ version: '1.2.3', artifactRef: 'v1.2.3' });
    });
});

describe('desiredDeploymentPersistence', () => {
    const dep = (id: string, node: string, gen = 1): DesiredDeployment => ({
        projectId: id,
        generation: gen,
        assignedNodeId: node,
        repoOwner: 'o',
        repoName: 'r',
        timeout: 1000,
        logId: 'log',
        dotenv: 'A=1',
        compose: 'services: {}',
        nginxConf: '# conf',
        domains: ['a.com'],
        services: [],
    });

    it('round-trips JSON, filters by assigned node, and deletes', async () => {
        await upsertDesiredDeploymentModel(dep('p1', 'nodeA'));
        await upsertDesiredDeploymentModel(dep('p1', 'nodeA', 2)); // replace
        await upsertDesiredDeploymentModel(dep('p2', 'nodeB'));
        expect((await getDesiredDeploymentModel('p1'))?.generation).toBe(2);
        expect(await getAllDesiredDeploymentsModel()).toHaveLength(2);
        expect((await getDesiredDeploymentsAssignedToModel('nodeA')).map((d) => d.projectId)).toEqual(['p1']);
        await deleteDesiredDeploymentModel('p1');
        expect(await getDesiredDeploymentModel('p1')).toBeNull();
    });
});
