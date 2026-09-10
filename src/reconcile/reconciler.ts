import { config } from '@/config';
import { getDesiredDeploymentsAssignedToModel } from '@/persistence/desiredDeploymentPersistence';
import { applyDeployment } from './deploy';
import { teardownProjectLocal } from './teardown';
import { renderAllNginx } from './nginxRender';
import { syncCertsToDisk } from './certs';
import { clearLocalGeneration, getLocalGeneration, listLocalProjects, setLocalGeneration } from './state';

const RECONCILE_INTERVAL_MS = 5000;

let running = false;
let timer: NodeJS.Timeout | undefined;

// Converge this host toward the replicated desired state. Runs on EVERY node.
export const reconcileTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
        const me = config.nodeId;
        const desired = await getDesiredDeploymentsAssignedToModel(me);
        const desiredIds = new Set(desired.map((d) => d.projectId));

        // A. Ensure everything assigned to me is at the right generation.
        for (const dep of desired) {
            const current = await getLocalGeneration(dep.projectId);
            if (current !== dep.generation) {
                await applyDeployment(dep);
            }
        }

        // B. Tear down anything previously deployed here that is no longer assigned to me.
        const localProjects = await listLocalProjects();
        for (const projectId of localProjects) {
            if (!desiredIds.has(projectId)) {
                console.log(`[reconcile] project ${projectId} no longer assigned here, tearing down`);
                await teardownProjectLocal(projectId);
                await clearLocalGeneration(projectId);
            }
        }

        // C. Ingress: render ALL projects' nginx + sync ALL certs (so any node can hold the VIP).
        await syncCertsToDisk();
        await renderAllNginx();
    } catch (e) {
        console.error('[reconcile] tick error:', e);
    } finally {
        running = false;
    }
};

export const startReconciler = (): void => {
    if (timer) return;
    timer = setInterval(() => void reconcileTick(), RECONCILE_INTERVAL_MS);
    void reconcileTick();
    console.log('[reconcile] loop started');
};

export const stopReconciler = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
};

// Exposed so an operator/test can force a project's generation marker (rarely needed).
export const forceLocalGeneration = setLocalGeneration;
