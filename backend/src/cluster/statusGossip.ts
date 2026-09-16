import { DockerStatus, NodeStatusReport } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { getPrimaryIp } from '@/host/exec';
import { listContainerData } from '@/reconcile/docker';
import { NSM_LABEL_SERVICE_INSTANCE_ID } from '@/constants';
import { cluster } from './node';
import { postToLeader } from './leaderClient';
import { touchNodeModel } from '@/persistence/nodePersistence';
import { updateServiceInstanceModel, getServiceInstanceByIdModel } from '@/persistence/serviceInstancePersistence';
import { areaLog } from '@/utils/log';

const gossipLog = areaLog('gossip');

// Leader-side cache of the latest report from each node.
const reports = new Map<string, NodeStatusReport>();

export const getNodeHealthReports = (): { [nodeId: string]: NodeStatusReport } => {
    const out: { [nodeId: string]: NodeStatusReport } = {};
    for (const [k, v] of reports) out[k] = v;
    return out;
};

// Leader ingests a report from a node: refresh the registry (so IP changes converge) and update
// observed service-instance states.
export const ingestReport = async (report: NodeStatusReport): Promise<void> => {
    reports.set(report.nodeId, report);
    const isSelf = report.nodeId === config.nodeId;
    await touchNodeModel(report.nodeId, report.currentAddress, report.apiPort, isSelf && cluster.isLeader());
    gossipLog.debug({ action: 'report_ingested', nodeId: report.nodeId, currentAddress: report.currentAddress, containerCount: report.containers.length, nsmVersion: report.nsmVersion }, 'gossip report ingested');
    for (const c of report.containers) {
        try {
            const existing = await getServiceInstanceByIdModel(c.serviceInstanceId);
            if (existing && existing.actualContainerState !== c.state) {
                await updateServiceInstanceModel(c.serviceInstanceId, { actualContainerState: c.state, containerId: c.containerId });
                gossipLog.info(
                    { action: 'service_state_changed', serviceInstanceId: c.serviceInstanceId, oldState: existing.actualContainerState, newState: c.state, reportingNodeId: report.nodeId },
                    `service ${c.serviceInstanceId} ${existing.actualContainerState} -> ${c.state}`
                );
            }
        } catch {
            /* observed state is best-effort */
        }
    }
};

const buildReport = async (): Promise<NodeStatusReport> => {
    let containers: NodeStatusReport['containers'] = [];
    try {
        const list = await listContainerData();
        containers = list
            .map((c) => ({ serviceInstanceId: c.Labels[NSM_LABEL_SERVICE_INSTANCE_ID], state: c.State as DockerStatus, containerId: c.ID }))
            .filter((c) => !!c.serviceInstanceId);
    } catch (e: any) {
        gossipLog.warn({ action: 'docker_list_failed', err: e?.message }, 'failed to list containers for status report');
    }
    return {
        nodeId: config.nodeId,
        nsmVersion: config.commit || config.version,
        healthy: true,
        currentAddress: await getPrimaryIp(),
        apiPort: config.apiPort,
        containers,
        ts: Date.now(),
    };
};

let timer: NodeJS.Timeout | undefined;

export const startStatusReporting = (): void => {
    if (timer) return;
    const tick = async () => {
        const report = await buildReport();
        if (cluster.isLeader()) {
            await ingestReport(report);
        } else {
            const res = await postToLeader('/cluster/status-report', report);
            if (!res) gossipLog.warn({ action: 'status_report_failed', nodeId: config.nodeId, leaderAddress: cluster.leaderAddress() }, 'failed to POST status report to leader');
            else gossipLog.debug({ action: 'status_report_sent', nodeId: config.nodeId, containerCount: report.containers.length }, 'status report sent to leader');
        }
    };
    timer = setInterval(() => void tick(), 15000);
    void tick();
    gossipLog.info({ action: 'status_reporting_started', nodeId: config.nodeId, intervalMs: 15000, isLeader: cluster.isLeader() }, 'status reporting started');
};

export const stopStatusReporting = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    gossipLog.info({ action: 'status_reporting_stopped', nodeId: config.nodeId }, 'status reporting stopped');
};
