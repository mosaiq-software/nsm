import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { appendToDeploymentLog, createProjectInstanceModel, deleteProjectInstanceModel, getAllActiveProjectInstancesModel, getProjectInstanceByIdModel, getProjectInstancesByProjectIdModel, updateProjectInstanceModel } from '@/persistence/projectInstancePersistence';
import { createServiceInstanceModel, deleteServiceInstanceModel, getServiceInstanceByIdModel, getServiceInstancesByProjectInstanceIdModel, updateServiceInstanceModel } from '@/persistence/serviceInstancePersistence';
import { createUserModel, getAllSignedInUsersModel, getUserByAuthTokenModel, updateUserModel } from '@/persistence/userPersistence';
import { createAllowedEntityModel, deleteAllowedEntitiesModel, getAllAllowedEntitiesModel, getAllowedOrganizationsModel, getAllowedUsersModel } from '@/persistence/allowedEntitiesPersistence';
import { AllowedEntityType, DeploymentState, DockerStatus, ProjectInstanceHeader, ProjectServiceInstance, User } from '@mosaiq/nsm-common/types';

beforeEach(async () => resetDb());

const header = (id: string, projectId = 'p1'): ProjectInstanceHeader => ({ id, projectId, workerNodeId: 'n1', state: DeploymentState.DEPLOYING, created: Date.now(), lastUpdated: Date.now(), active: true, directories: {} });

describe('projectInstancePersistence', () => {
    it('creates, updates state, filters active, and deletes', async () => {
        await createProjectInstanceModel(header('i1'));
        await createProjectInstanceModel(header('i2'));
        expect(await getProjectInstancesByProjectIdModel('p1')).toHaveLength(2);
        expect(await getAllActiveProjectInstancesModel()).toHaveLength(2);
        await updateProjectInstanceModel('i2', { active: false, state: DeploymentState.DEPLOYED });
        expect(await getAllActiveProjectInstancesModel()).toHaveLength(1);
        await deleteProjectInstanceModel('i1');
        expect(await getProjectInstanceByIdModel('i1')).toBeNull();
    });

    it('appends to the deployment log atomically', async () => {
        await createProjectInstanceModel(header('i1'));
        await Promise.all([appendToDeploymentLog('i1', 'a'), appendToDeploymentLog('i1', 'b'), appendToDeploymentLog('i1', 'c')]);
        const inst = await getProjectInstanceByIdModel('i1');
        expect(inst?.deploymentLog?.length).toBe(3);
        expect([...(inst?.deploymentLog ?? '')].sort().join('')).toBe('abc');
    });
});

describe('serviceInstancePersistence', () => {
    const svc = (id: string): ProjectServiceInstance => ({
        instanceId: id,
        projectInstanceId: 'i1',
        serviceName: 'web',
        containerId: undefined,
        expectedContainerState: DockerStatus.RUNNING,
        actualContainerState: DockerStatus.UNKNOWN,
        containerLogs: '',
        created: Date.now(),
        lastUpdated: Date.now(),
    });

    it('creates, updates observed state, and deletes', async () => {
        await createServiceInstanceModel(svc('s1'));
        await updateServiceInstanceModel('s1', { actualContainerState: DockerStatus.RUNNING, containerId: 'abc' });
        const got = await getServiceInstanceByIdModel('s1');
        expect(got?.actualContainerState).toBe(DockerStatus.RUNNING);
        expect(got?.containerId).toBe('abc');
        expect(await getServiceInstancesByProjectInstanceIdModel('i1')).toHaveLength(1);
        await deleteServiceInstanceModel('s1');
        expect(await getServiceInstanceByIdModel('s1')).toBeUndefined();
    });
});

describe('userPersistence', () => {
    const user = (over: Partial<User> = {}): User => ({ githubId: 'g1', name: 'octocat', authToken: 'tok', avatarUrl: '', created: Date.now(), signedIn: true, ...over });

    it('upserts by githubId and looks up by auth token', async () => {
        await createUserModel(user());
        await createUserModel(user({ name: 'renamed' })); // upsert, same githubId
        expect((await getUserByAuthTokenModel('tok'))?.name).toBe('renamed');
        expect(await getAllSignedInUsersModel()).toHaveLength(1);
        await updateUserModel({ githubId: 'g1', signedIn: false });
        expect(await getAllSignedInUsersModel()).toHaveLength(0);
    });
});

describe('allowedEntitiesPersistence', () => {
    it('separates users and organizations', async () => {
        await createAllowedEntityModel({ id: 'octocat', type: AllowedEntityType.USER, avatarUrl: '' });
        await createAllowedEntityModel({ id: 'mosaiq', type: AllowedEntityType.ORGANIZATION, avatarUrl: '' });
        expect((await getAllowedUsersModel()).map((e) => e.id)).toEqual(['octocat']);
        expect((await getAllowedOrganizationsModel()).map((e) => e.id)).toEqual(['mosaiq']);
        expect(await getAllAllowedEntitiesModel()).toHaveLength(2);
        await deleteAllowedEntitiesModel('octocat');
        expect(await getAllAllowedEntitiesModel()).toHaveLength(1);
    });
});
