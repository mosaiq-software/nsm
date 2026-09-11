import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { getProjectInstance, getAllActiveServices, deleteProjectInstancesForProject } from '@/controllers/projectInstanceController';
import { createProjectInstanceModel, getProjectInstanceByIdModel } from '@/persistence/projectInstancePersistence';
import { createServiceInstanceModel, getServiceInstancesByProjectInstanceIdModel } from '@/persistence/serviceInstancePersistence';
import { DeploymentState, DockerStatus, ProjectServiceInstance } from '@mosaiq/nsm-common/types';

beforeEach(async () => resetDb());

const svc = (id: string, piId: string): ProjectServiceInstance => ({ instanceId: id, projectInstanceId: piId, serviceName: 'web', containerId: undefined, expectedContainerState: DockerStatus.RUNNING, actualContainerState: DockerStatus.UNKNOWN, collectContainerLogs: false, containerLogs: '', created: Date.now(), lastUpdated: Date.now() });
const inst = (id: string, projectId: string, active: boolean) => ({ id, projectId, workerNodeId: 'n', state: DeploymentState.DEPLOYED, created: Date.now(), lastUpdated: Date.now(), active, directories: {} });

describe('projectInstanceController', () => {
    it('assembles a project instance with its services', async () => {
        await createProjectInstanceModel(inst('i1', 'p1', true));
        await createServiceInstanceModel(svc('s1', 'i1'));
        const got = await getProjectInstance('i1');
        expect(got?.id).toBe('i1');
        expect(got?.services).toHaveLength(1);
        expect(await getProjectInstance('missing')).toBeUndefined();
    });

    it('collects services from all active instances only', async () => {
        await createProjectInstanceModel(inst('i1', 'p1', true));
        await createProjectInstanceModel(inst('i2', 'p1', false));
        await createServiceInstanceModel(svc('s1', 'i1'));
        await createServiceInstanceModel(svc('s2', 'i2'));
        const active = await getAllActiveServices();
        expect(active.map((s) => s.instanceId)).toEqual(['s1']);
    });

    it('deletes all instances and their services for a project', async () => {
        await createProjectInstanceModel(inst('i1', 'p1', true));
        await createServiceInstanceModel(svc('s1', 'i1'));
        await deleteProjectInstancesForProject('p1');
        expect(await getProjectInstanceByIdModel('i1')).toBeNull();
        expect(await getServiceInstancesByProjectInstanceIdModel('i1')).toHaveLength(0);
    });
});
