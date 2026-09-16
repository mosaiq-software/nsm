import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe, getPrimaryIp } from '@/host/exec';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const obsLog = areaLog('observability');

// Leader only: bring up the self-hosted observability stack (Grafana + Loki + Prometheus) as a
// docker compose project. Idempotent - safe to call on every boot. Also seeds an initial (empty)
// Prometheus file-SD directory so Prometheus starts cleanly before the first reconcile tick.
const OBS_PROJECT = 'nsm-observability';
const AGENT_PROJECT = 'nsm-agent';
const PROM_SD_DIR = '/etc/nsm/prometheus';

export const ensureObservabilityStack = async (): Promise<void> => {
    if (!config.production) return;
    try {
        await fs.mkdir(PROM_SD_DIR, { recursive: true });
        for (const f of ['targets_node.json', 'targets_cadvisor.json', 'targets_nsmd.json']) {
            const path = `${PROM_SD_DIR}/${f}`;
            try {
                await fs.access(path);
            } catch {
                await fs.writeFile(path, '[]');
            }
        }
        const composePath = `${config.nsmRepoDir}/deploy/observability/docker-compose.yml`;
        const { out, code } = await execSafe(`docker compose -p ${OBS_PROJECT} -f ${composePath} up -d`, 1000 * 60 * 3);
        if (code !== 0) obsLog.error({ action: 'obs_stack_failed', exitCode: code, out }, 'failed to start observability stack');
        else obsLog.info({ action: 'obs_stack_ready', composePath }, 'observability stack ensured');
    } catch (e: any) {
        obsLog.error({ action: 'obs_stack_error', err: e?.message }, 'ensureObservabilityStack error');
    }
};

// Every node: bring up the per-node telemetry agents (Alloy for logs, node_exporter, cadvisor) and
// point Alloy at a Loki push URL that is actually reachable from INSIDE the container. The compose
// default (127.0.0.1:3100) is the container's own loopback, so it must be overridden: on the leader
// with the host's own LAN IP (Loki is published there); elsewhere with the leader host. Idempotent -
// re-running `up -d` recreates Alloy only when the derived env changes. Runs on every node at boot.
export const ensureAgentStack = async (): Promise<void> => {
    if (!config.production) return;
    try {
        // deriveLokiPush() (config.obsLokiPushUrl) yields http://<leaderHost>:3100, correct for
        // followers but useless on the leader (its leaderAddress is 127.0.0.1); use the LAN IP there.
        const pushUrl = cluster.isLeader() ? `http://${await getPrimaryIp()}:3100` : config.obsLokiPushUrl;
        const composePath = `${config.nsmRepoDir}/deploy/agent/docker-compose.yml`;
        const cmd = `NODE_ID=${config.nodeId} OBS_LOKI_PUSH_URL=${pushUrl} docker compose -p ${AGENT_PROJECT} -f ${composePath} up -d`;
        const { out, code } = await execSafe(cmd, 1000 * 60 * 3);
        if (code !== 0) obsLog.error({ action: 'agent_stack_failed', pushUrl, exitCode: code, out }, 'failed to start per-node agent stack');
        else obsLog.info({ action: 'agent_stack_ready', pushUrl }, 'per-node agent stack ensured');
    } catch (e: any) {
        obsLog.error({ action: 'agent_stack_error', err: e?.message }, 'ensureAgentStack error');
    }
};
