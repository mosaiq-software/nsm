import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';
import { RegistryNode } from '@/cluster/registry';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';
import { getDesiredDeploymentsAssignedToModel, upsertDesiredDeploymentModel, deleteDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { applyDeployment } from './deploy';
import { teardownProjectLocal, teardownGenerationLocal } from './teardown';
import { renderAllNginx } from './nginxRender';
import { leaderEnsureCerts } from './certs';
import { refreshInternalHosts } from './internalDns';
import { regeneratePromTargets } from './promTargets';
import { clearLocalGeneration, getLocalGeneration, getLiveGenerations, getReadyGeneration, listLocalProjects, removeLiveGeneration, setLocalGeneration } from './state';
import { reconcileDuration, errorsTotal } from '@/utils/metrics';
import { areaLog } from '@/utils/log';

const reconcileLog = areaLog('reconcile');

const RECONCILE_INTERVAL_MS = 5000;

let running = false;
let timer: NodeJS.Timeout | undefined;

// Generations scheduled to be drained (torn down) after the grace period, keyed `${projectId}:${gen}`.
// Prevents re-scheduling the same teardown on every 5s tick while the timer is pending.
const drainScheduled = new Set<string>();

// After a zero-downtime cutover (leader promoted a newer generation), tear down any live generation
// older than the active one - but only after config.deployDrainMs so in-flight requests to the old
// upstream can finish. Non-blocking: scheduled via setTimeout so it never stalls the reconcile loop.
const scheduleDrain = (projectId: string, activeGeneration: number): void => {
    void (async () => {
        const live = await getLiveGenerations(projectId);
        for (const g of live) {
            if (g >= activeGeneration) continue;
            const key = `${projectId}:${g}`;
            if (drainScheduled.has(key)) continue;
            drainScheduled.add(key);
            reconcileLog.info({ action: 'drain_scheduled', projectId, generation: g, activeGeneration, drainDelayMs: config.deployDrainMs }, `scheduled drain of ${projectId} generation ${g}`);
            setTimeout(async () => {
                try {
                    await teardownGenerationLocal(projectId, g);
                    await removeLiveGeneration(projectId, g);
                    reconcileLog.info({ action: 'generation_drained', projectId, generation: g }, `drained ${projectId} generation ${g}`);
                } catch (e: any) {
                    reconcileLog.error({ action: 'drain_failed', projectId, generation: g, err: e?.message }, `failed to drain ${projectId} generation ${g}`);
                } finally {
                    drainScheduled.delete(key);
                }
            }, config.deployDrainMs);
        }
    })();
};

interface DesiredPullResponse {
    deployments: DesiredDeployment[];
    registry: RegistryNode[];
}

// Followers pull their assigned desired state from the leader and mirror it into the local DB so
// the generation-drift reconciler below can run unchanged. Returns false if the leader is
// unreachable (in which case we must NOT tear anything down).
const pullDesiredState = async (): Promise<boolean> => {
    const resp = await postToLeader<DesiredPullResponse>('/node/desired', { nodeId: config.nodeId });
    if (!resp) return false;
    const present = new Set(resp.deployments.map((d) => d.projectId));
    for (const d of resp.deployments) await upsertDesiredDeploymentModel(d);
    for (const local of await getDesiredDeploymentsAssignedToModel(config.nodeId)) {
        if (!present.has(local.projectId)) await deleteDesiredDeploymentModel(local.projectId);
    }
    reconcileLog.debug({ action: 'desired_pulled', nodeId: config.nodeId, deploymentCount: resp.deployments.length }, `pulled ${resp.deployments.length} desired deployment(s)`);
    return true;
};

// Converge this host toward the desired state. Runs on EVERY node.
export const reconcileTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    const endTimer = reconcileDuration.startTimer();
    try {
        // Followers sync their assigned set from the leader first. The leader is authoritative
        // and reconciles straight from its own DB.
        if (!cluster.isLeader()) {
            const ok = await pullDesiredState();
            if (!ok) return; // leader unreachable: leave running apps alone, skip this tick
        }

        const me = config.nodeId;
        const desired = await getDesiredDeploymentsAssignedToModel(me);
        const desiredIds = new Set(desired.map((d) => d.projectId));

        // A. Ensure everything assigned to me is at the right generation.
        for (const dep of desired) {
            if (dep.zeroDowntime) {
                // Blue-green: bring up the new generation (blue) only until it has passed its
                // readiness gate (reported ready). Drift is keyed on the READY generation so a
                // half-deployed blue is retried on the next tick.
                const ready = await getReadyGeneration(dep.projectId);
                if (ready !== dep.generation) {
                    reconcileLog.info({ action: 'drift_correcting', projectId: dep.projectId, generation: dep.generation, readyGeneration: ready, zeroDowntime: true }, `applying ${dep.projectId} gen ${dep.generation} (zero-downtime)`);
                    await applyDeployment(dep);
                }
                // Once the leader has promoted (activeGeneration advanced -> nginx flipped), drain
                // any older generations after the grace period.
                if (dep.activeGeneration != null) {
                    scheduleDrain(dep.projectId, dep.activeGeneration);
                }
            } else {
                const current = await getLocalGeneration(dep.projectId);
                if (current !== dep.generation) {
                    reconcileLog.info({ action: 'drift_correcting', projectId: dep.projectId, generation: dep.generation, currentGeneration: current, zeroDowntime: false }, `applying ${dep.projectId} gen ${dep.generation}`);
                    await applyDeployment(dep);
                }
            }
        }

        // B. Tear down anything previously deployed here that is no longer assigned to me.
        const localProjects = await listLocalProjects();
        for (const projectId of localProjects) {
            if (!desiredIds.has(projectId)) {
                reconcileLog.info({ action: 'unassigned_teardown', projectId, nodeId: config.nodeId }, `project ${projectId} no longer assigned here, tearing down`);
                await teardownProjectLocal(projectId);
                await clearLocalGeneration(projectId);
            }
        }

        // C. Ingress + observability wiring: leader only (single TLS entrypoint + registry-driven
        // internal DNS and Prometheus targets).
        if (cluster.isLeader()) {
            // Render BEFORE issuing certs: rendering only writes SSL vhosts for domains that already
            // have certs and removes any stale conf referencing a missing cert, so nginx is left in
            // a valid, reloadable state. certbot (--nginx) then always has a healthy nginx to work
            // with - this ordering is what lets an already-wedged leader self-heal, instead of a
            // broken conf blocking certbot (which would otherwise wait out the failure cooldown).
            await renderAllNginx();
            await leaderEnsureCerts();
            await refreshInternalHosts();
            await regeneratePromTargets();
        }
    } catch (e: any) {
        reconcileLog.error({ action: 'tick_error', err: e?.message }, 'reconcile tick error');
        errorsTotal.inc({ area: 'reconcile' });
    } finally {
        endTimer();
        running = false;
    }
};

export const startReconciler = (): void => {
    if (timer) return;
    timer = setInterval(() => void reconcileTick(), RECONCILE_INTERVAL_MS);
    void reconcileTick();
    reconcileLog.info({ action: 'reconciler_started', intervalMs: RECONCILE_INTERVAL_MS }, 'reconcile loop started');
};

export const stopReconciler = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
};

// Exposed so an operator/test can force a project's generation marker (rarely needed).
export const forceLocalGeneration = setLocalGeneration;
