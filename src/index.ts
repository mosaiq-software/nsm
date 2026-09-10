import { config } from './config';
import '@/store/registerModels';
import { sequelize } from './utils/dbHelper';
import { initApp } from './app';
import { applyGithubFingerprints, ensureBaseDirectories, handleSignals, registerCronJobs } from './utils/initUtils';
import { cluster } from './cluster/node';
import { startReconciler } from './reconcile/reconciler';
import { startStatusReporting } from './cluster/statusGossip';
import { ensureKeepalived } from './reconcile/keepalived';

const start = async () => {
    applyGithubFingerprints();
    await ensureBaseDirectories();

    // Materialized view store must be ready before raft starts applying ops.
    await sequelize.sync();

    // Start consensus (leader election + replicated log apply).
    await cluster.init();

    // Data-plane ingress: participate in VRRP for the VIP.
    await ensureKeepalived();

    // Converge local host toward desired state; report status to the leader.
    startReconciler();
    startStatusReporting();

    const app = await initApp();
    const server = app.listen(config.apiPort, () => {
        console.log(`NSM daemon ${config.nodeId} listening on :${config.apiPort} (version ${config.version})`);
    });

    handleSignals(server);
    registerCronJobs();
};

start().catch((e) => {
    console.error('Fatal startup error:', e);
    process.exit(1);
});
