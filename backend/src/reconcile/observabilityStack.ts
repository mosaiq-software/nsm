import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { areaLog } from '@/utils/log';

const obsLog = areaLog('observability');

// Leader only: bring up the self-hosted observability stack (Grafana + Loki + Prometheus) as a
// docker compose project. Idempotent - safe to call on every boot. Also seeds an initial (empty)
// Prometheus file-SD directory so Prometheus starts cleanly before the first reconcile tick.
const OBS_PROJECT = 'nsm-observability';
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
