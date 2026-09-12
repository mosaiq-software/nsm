import { config } from './config';
import '@/store/registerModels';
import { sequelize } from './utils/dbHelper';
import { initApp } from './app';
import { applyGithubFingerprints, ensureBaseDirectories, handleSignals, registerCronJobs } from './utils/initUtils';
import { ensureSelfRegistered } from './cluster/registry';
import { startReconciler } from './reconcile/reconciler';
import { startStatusReporting } from './cluster/statusGossip';
import { ensureObservabilityStack } from './reconcile/observabilityStack';
import { ensureSecretSchema } from './persistence/secretPersistence';
import { recoverDeployQueue } from './controllers/deployQueue';

const start = async () => {
    applyGithubFingerprints();
    await ensureBaseDirectories();

    // Source-of-truth store must be ready before we register or reconcile.
    await sequelize.sync();
    await ensureSecretSchema();

    // Register this node (and its current IP) into the leader-hosted registry.
    await ensureSelfRegistered();

    // Leader only: bring up the self-hosted observability stack (Grafana + Loki + Prometheus) and
    // resume any deploys that were still queued when the leader last stopped.
    if (config.role === 'leader') {
        await ensureObservabilityStack();
        await recoverDeployQueue();
    }

    // Converge local host toward desired state; report status/IP to the leader.
    startReconciler();
    startStatusReporting();

    const app = await initApp();
    const server = app.listen(config.apiPort, () => {
        console.log(`NSM daemon ${config.nodeId} (${config.role}) listening on :${config.apiPort} (version ${config.version})`);
    });

    handleSignals(server);
    registerCronJobs();
};

start().catch((e) => {
    console.error('Fatal startup error:', e);
    process.exit(1);
});
