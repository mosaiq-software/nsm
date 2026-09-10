import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { applyOp } from '@/cluster/stateMachine';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { AllowedEntityType, DeploymentState, Project, Secret, User } from '@mosaiq/nsm-common/types';
import { getProjectByIdModel } from '@/persistence/projectPersistence';
import { getAllSecretsForProjectModel } from '@/persistence/secretPersistence';
import { getDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { getCertModel } from '@/persistence/certPersistence';
import { getAllNodesModel, getNodeByIdModel } from '@/persistence/nodePersistence';
import { getDesiredNsmVersion, getLastAppliedIndex } from '@/persistence/clusterMetaPersistence';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';

beforeEach(async () => resetDb());

const project = (id: string, over: Partial<Project> = {}): Project => ({ id, repoOwner: 'o', repoName: 'r', state: DeploymentState.READY, deploymentKey: 'k', allowCICD: false, ...over });
const sec = (name: string, value = 'v'): Secret => ({ projectId: 'p1', secretName: name, secretValue: value, secretPlaceholder: '', variable: false });

describe('applyOp', () => {
    it('advances lastAppliedIndex on every op', async () => {
        await applyOp({ type: OpType.UPSERT_PROJECT, project: project('p1') }, 5);
        expect(await getLastAppliedIndex()).toBe(5);
        await applyOp({ type: OpType.UPSERT_CERT, cert: { domain: 'a.com', fullchainPem: 'f', privkeyPem: 'p', notAfter: 1 } }, 6);
        expect(await getLastAppliedIndex()).toBe(6);
    });

    it('UPSERT_PROJECT persists serialized config and is idempotent', async () => {
        const p = project('p1', { hasDockerCompose: true, services: [] });
        await applyOp({ type: OpType.UPSERT_PROJECT, project: p }, 1);
        await applyOp({ type: OpType.UPSERT_PROJECT, project: p }, 2);
        const row = await getProjectByIdModel('p1');
        expect(row?.hasDockerCompose).toBe(true);
        expect(JSON.parse(row!.nginxConfigJson)).toEqual({ servers: [] });
    });

    it('DELETE_PROJECT also clears the desired deployment', async () => {
        await applyOp({ type: OpType.UPSERT_PROJECT, project: project('p1') }, 1);
        await applyOp({ type: OpType.SET_DESIRED_DEPLOYMENT, deployment: { projectId: 'p1', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', domains: [], services: [] } }, 2);
        await applyOp({ type: OpType.DELETE_PROJECT, projectId: 'p1' }, 3);
        expect(await getProjectByIdModel('p1')).toBeUndefined();
        expect(await getDesiredDeploymentModel('p1')).toBeNull();
    });

    it('SET_PROJECT_SECRETS replaces the whole set; UPSERT_SECRET edits one', async () => {
        await applyOp({ type: OpType.SET_PROJECT_SECRETS, projectId: 'p1', secrets: [sec('A'), sec('B')] }, 1);
        expect(await getAllSecretsForProjectModel('p1')).toHaveLength(2);
        await applyOp({ type: OpType.SET_PROJECT_SECRETS, projectId: 'p1', secrets: [sec('C')] }, 2);
        expect((await getAllSecretsForProjectModel('p1')).map((s) => s.secretName)).toEqual(['C']);
        await applyOp({ type: OpType.UPSERT_SECRET, secret: sec('C', 'updated') }, 3);
        expect((await getAllSecretsForProjectModel('p1'))[0].secretValue).toBe('updated');
    });

    it('SET_PROJECT_ASSIGNMENT updates the assigned node', async () => {
        await applyOp({ type: OpType.UPSERT_PROJECT, project: project('p1') }, 1);
        await applyOp({ type: OpType.SET_PROJECT_ASSIGNMENT, projectId: 'p1', nodeId: 'node-x' }, 2);
        expect((await getProjectByIdModel('p1'))?.workerNodeId).toBe('node-x');
    });

    it('node add/remove and cert/version ops', async () => {
        await applyOp({ type: OpType.UPSERT_NODE, node: { nodeId: 'n1', address: '1.1.1.1', raftPort: 1, apiPort: 2 } }, 1);
        expect((await getNodeByIdModel('n1'))?.voter).toBe(true);
        await applyOp({ type: OpType.REMOVE_NODE, nodeId: 'n1' }, 2);
        expect(await getAllNodesModel()).toHaveLength(0);
        await applyOp({ type: OpType.UPSERT_CERT, cert: { domain: 'a.com', fullchainPem: 'FC', privkeyPem: 'PK', notAfter: 99 } }, 3);
        expect((await getCertModel('a.com'))?.fullchainPem).toBe('FC');
        await applyOp({ type: OpType.SET_DESIRED_NSM_VERSION, version: '2.0.0', artifactRef: 'v2.0.0' }, 4);
        expect(await getDesiredNsmVersion()).toEqual({ version: '2.0.0', artifactRef: 'v2.0.0' });
    });

    it('UPSERT_USER and SET_ALLOWED_ENTITIES (replace semantics)', async () => {
        const user: User = { githubId: 'g', name: 'n', authToken: 'tok', avatarUrl: '', created: 1, signedIn: true };
        await applyOp({ type: OpType.UPSERT_USER, user }, 1);
        expect((await getUserByAuthTokenModel('tok'))?.name).toBe('n');
        await applyOp({ type: OpType.SET_ALLOWED_ENTITIES, entities: [{ id: 'a', type: AllowedEntityType.USER, avatarUrl: '' }] }, 2);
        await applyOp({ type: OpType.SET_ALLOWED_ENTITIES, entities: [{ id: 'b', type: AllowedEntityType.ORGANIZATION, avatarUrl: '' }] }, 3);
        const all = await getAllAllowedEntitiesModel();
        expect(all.map((e) => e.id)).toEqual(['b']);
    });
});
