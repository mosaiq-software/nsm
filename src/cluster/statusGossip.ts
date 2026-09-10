import { DockerStatus, NodeStatusReport } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { listContainerData } from '@/reconcile/docker';
import { NSM_LABEL_SERVICE_INSTANCE_ID } from '@/constants';
import { cluster } from './node';
import { postToLeader } from './leaderClient';
import { updateServiceInstanceModel, getServiceInstanceByIdModel } from '@/persistence/serviceInstancePersistence';

// Leader-side cache of the latest report from each node (intentionally NOT replicated via raft).
const reports = new Map<string, NodeStatusReport>();

export const getNodeHealthReports = (): { [nodeId: string]: NodeStatusReport } => {
    const out: { [nodeId: string]: NodeStatusReport } = {};
    for (const [k, v] of reports) out[k] = v;
    return out;
};

// Leader ingests a report from a node and updates observed service-instance states.
export const ingestReport = async (report: NodeStatusReport): Promise<void> => {
    reports.set(report.nodeId, report);
    for (const c of report.containers) {
        try {
            const existing = await getServiceInstanceByIdModel(c.serviceInstanceId);
            if (existing && existing.actualContainerState !== c.state) {
                await updateServiceInstanceModel(c.serviceInstanceId, { actualContainerState: c.state, containerId: c.containerId });
            }
        } catch {
            /* observed state is best-effort */
        }
    }
};

export const isVipHolder = async (): Promise<boolean> => {
    if (!config.production || !config.vip) return false;
    const { out, code } = await execSafe(`ip -o addr show`, 3000);
    if (code !== 0) return false;
    return out.includes(`${config.vip}/`) || out.includes(` ${config.vip} `);
};

const buildReport = async (): Promise<NodeStatusReport> => {
    let containers: NodeStatusReport['containers'] = [];
    try {
        const list = await listContainerData();
        containers = list
            .map((c) => ({ serviceInstanceId: c.Labels[NSM_LABEL_SERVICE_INSTANCE_ID], state: c.State as DockerStatus, containerId: c.ID }))
            .filter((c) => !!c.serviceInstanceId);
    } catch {
        /* ignore */
    }
    return {
        nodeId: config.nodeId,
        nsmVersion: config.version,
        healthy: true,
        isLeader: cluster.isLeader(),
        vipHolder: await isVipHolder(),
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
            await postToLeader('/cluster/status-report', report);
        }
    };
    timer = setInterval(() => void tick(), 30000);
    void tick();
};

export const stopStatusReporting = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
};
