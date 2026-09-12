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
import { initWebPush } from './controllers/pushController';

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
        await initWebPush();
    }

    // Converge local host toward desired state; report status/IP to the leader.
    startReconciler();
    startStatusReporting();

    const app = await initApp();
    const server = app.listen(config.apiPort, () => {
        console.log(`NSM daemon ${config.nodeId} (${config.role}) listening on :${config.apiPort} (version ${config.version})`);
    });

    // Keep the daemon's keep-alive window longer than any fronting proxy's, so a proxy can never
    // reuse a connection the daemon has already closed - that race surfaces as a 502 ("upstream
    // prematurely closed connection") on the first request after an idle period. Node's defaults
    // (keepAliveTimeout 5s) are shorter than typical nginx timeouts, which is the wrong ordering.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    handleSignals(server);
    registerCronJobs();
};

start().catch((e) => {
    console.error('Fatal startup error:', e);
    process.exit(1);
});
