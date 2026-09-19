import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: () => true } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn() }));

import { ingestReport, getNodeHealthReports } from '@/cluster/statusGossip';
import { createServiceInstanceModel, getServiceInstanceByIdModel } from '@/persistence/serviceInstancePersistence';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { DockerStatus, NodeStatusReport, ProjectServiceInstance } from '@mosaiq/nsm-common/types';

const svc = (id: string): ProjectServiceInstance => ({ instanceId: id, projectInstanceId: 'pi', serviceName: 'web', containerId: undefined, expectedContainerState: DockerStatus.RUNNING, actualContainerState: DockerStatus.UNKNOWN, containerLogs: '', created: Date.now(), lastUpdated: Date.now() });

const report = (over: Partial<NodeStatusReport> = {}): NodeStatusReport => ({ nodeId: 'n1', nsmVersion: '1.0.0', healthy: true, currentAddress: '10.0.0.5', apiPort: 1025, containers: [], ts: Date.now(), ...over });

beforeEach(async () => resetDb());

describe('ingestReport', () => {
    it('caches the report and updates observed service-instance state', async () => {
        await createServiceInstanceModel(svc('s1'));
        const r = report({ containers: [{ serviceInstanceId: 's1', state: DockerStatus.RUNNING, containerId: 'c1' }] });
        await ingestReport(r);
        expect(getNodeHealthReports()['n1']).toEqual(r);
        const updated = await getServiceInstanceByIdModel('s1');
        expect(updated?.actualContainerState).toBe(DockerStatus.RUNNING);
        expect(updated?.containerId).toBe('c1');
    });

    it('refreshes the registry so an IP change for a stable nodeId propagates', async () => {
        await ingestReport(report({ currentAddress: '10.0.0.5' }));
        expect((await getNodeByIdModel('n1'))?.address).toBe('10.0.0.5');
        await ingestReport(report({ currentAddress: '10.0.0.9' }));
        expect((await getNodeByIdModel('n1'))?.address).toBe('10.0.0.9');
    });

    it('ignores containers referencing unknown service instances', async () => {
        await ingestReport(report({ containers: [{ serviceInstanceId: 'ghost', state: DockerStatus.RUNNING }] }));
        expect(getNodeHealthReports()['n1']).toBeTruthy();
    });
});
