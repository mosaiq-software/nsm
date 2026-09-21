import { config } from './config';
import '@/store/registerModels';
import { sequelize } from './utils/dbHelper';
import { initApp } from './app';
import { applyGithubFingerprints, ensureBaseDirectories, handleSignals, registerCronJobs } from './utils/initUtils';
import { ensureSelfRegistered } from './cluster/registry';
import { startReconciler } from './reconcile/reconciler';
import { startStatusReporting } from './cluster/statusGossip';
import { ensureObservabilityStack, ensureAgentStack } from './reconcile/observabilityStack';
import { runMigrations } from './db/migrator';
import { recoverDeployQueue } from './controllers/deployQueue';
import { sweepStuckDestroyingInstances } from './controllers/deployController';
import { initWebPush } from './controllers/pushController';
import { collectDiskUsage } from './reconcile/diskUsage';
import { areaLog, serializeError } from './utils/log';

const bootLog = areaLog('startup');

// Daemon resilience backstop. A single un-caught async error in a request handler (e.g. a DB query
// hitting schema drift) must never take down the whole daemon: without this, an unhandled promise
// rejection crashes the process, systemd restarts it, and the offending request keeps re-killing it
// - a full outage from one bad query. Log and keep running instead.
process.on('unhandledRejection', (reason) => {
    bootLog.error({ action: 'unhandled_rejection', err: serializeError(reason) }, 'unhandledRejection (kept alive)');
});
process.on('uncaughtException', (err) => {
    bootLog.error({ action: 'uncaught_exception', err: serializeError(err) }, 'uncaughtException (kept alive)');
});

const start = async () => {
    applyGithubFingerprints();
    await ensureBaseDirectories();

    // Source-of-truth store must be ready before we register or reconcile. sync() creates any
    // missing tables; migrations then reconcile schema changes sync() can't apply (e.g. adding a
    // column to an existing table).
    await sequelize.sync();
    await runMigrations();
    bootLog.info({ action: 'db_ready' }, 'database synced and migrations applied');

    // Register this node (and its current IP) into the leader-hosted registry.
    await ensureSelfRegistered();
    bootLog.info({ action: 'self_registered' }, 'node registered into cluster registry');

    // Every node: bring up the per-node telemetry agents (Alloy/node_exporter/cadvisor) with a
    // Loki push URL derived to be reachable from inside the container. Depends on self-registration
    // only for getPrimaryIp() being meaningful; safe to run before the leader-only stack.
    await ensureAgentStack();

    // Leader only: bring up the self-hosted observability stack (Grafana + Loki + Prometheus) and
    // resume any deploys that were still queued when the leader last stopped.
    if (config.role === 'leader') {
        await ensureObservabilityStack();
        await recoverDeployQueue();
        await sweepStuckDestroyingInstances();
        await initWebPush();
        bootLog.info({ action: 'leader_services_ready' }, 'observability stack, deploy queue and web push initialized');
    }

    // Converge local host toward desired state; report status/IP to the leader.
    startReconciler();
    startStatusReporting();

    // Seed the per-project disk-usage gauge once at startup so the storage view has data before the
    // first 30-minute cron tick. Fire-and-forget: a slow scan must not delay the daemon coming up.
    void collectDiskUsage().catch((e) => bootLog.error({ action: 'initial_disk_usage_failed', err: serializeError(e) }, 'initial disk usage collection failed'));

    const app = await initApp();
    const server = app.listen(config.apiPort, () => {
        bootLog.info(
            { action: 'listening', port: config.apiPort, version: config.version, commit: config.commit },
            `NSM daemon ${config.nodeId} (${config.role}) listening on :${config.apiPort} (version ${config.version})`
        );
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
    bootLog.fatal({ action: 'startup_failed', err: serializeError(e) }, 'fatal startup error');
    process.exit(1);
});
