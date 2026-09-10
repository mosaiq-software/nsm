import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { isLeader: () => true } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: vi.fn() }));

import { config } from '@/config';
import { ingestReport, getNodeHealthReports, isVipHolder } from '@/cluster/statusGossip';
import { createServiceInstanceModel, getServiceInstanceByIdModel } from '@/persistence/serviceInstancePersistence';
import { DockerStatus, NodeStatusReport, ProjectServiceInstance } from '@mosaiq/nsm-common/types';

const svc = (id: string): ProjectServiceInstance => ({ instanceId: id, projectInstanceId: 'pi', serviceName: 'web', containerId: undefined, expectedContainerState: DockerStatus.RUNNING, actualContainerState: DockerStatus.UNKNOWN, collectContainerLogs: false, containerLogs: '', created: Date.now(), lastUpdated: Date.now() });

const report = (over: Partial<NodeStatusReport> = {}): NodeStatusReport => ({ nodeId: 'n1', nsmVersion: '1.0.0', healthy: true, isLeader: false, vipHolder: false, containers: [], ts: Date.now(), ...over });

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

    it('ignores containers referencing unknown service instances', async () => {
        await ingestReport(report({ containers: [{ serviceInstanceId: 'ghost', state: DockerStatus.RUNNING }] }));
        expect(getNodeHealthReports()['n1']).toBeTruthy();
    });
});

describe('isVipHolder', () => {
    it('is false in non-production or without a VIP', async () => {
        config.production = false;
        expect(await isVipHolder()).toBe(false);
    });
});
