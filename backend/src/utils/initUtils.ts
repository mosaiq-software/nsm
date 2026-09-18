import { execSync } from 'child_process';
import { exit } from 'process';
import * as fs from 'fs/promises';
import cron from 'node-cron';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { leaderEnsureCerts } from '@/reconcile/certs';
import { runSelfUpdateRolloutIfLeader } from '@/cluster/selfUpdate';
import { collectDiskUsage } from '@/reconcile/diskUsage';
import { areaLog } from '@/utils/log';

const initLog = areaLog('startup');

const githubPublicFingerprint1 = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const githubPublicFingerprint2 = 'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=';
const githubPublicFingerprint3 = 'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=';

export const applyGithubFingerprints = () => {
    if (!config.production) return;
    try {
        execSync(`mkdir -p ~/.ssh`);
        execSync(`echo "${githubPublicFingerprint1}" >> ~/.ssh/known_hosts`);
        execSync(`echo "${githubPublicFingerprint2}" >> ~/.ssh/known_hosts`);
        execSync(`echo "${githubPublicFingerprint3}" >> ~/.ssh/known_hosts`);
        initLog.info({ action: 'github_fingerprints_applied' }, 'applied GitHub SSH fingerprints to known_hosts');
    } catch (e: any) {
        initLog.error({ action: 'github_fingerprints_failed', err: e?.message }, 'error adding GitHub fingerprints to known_hosts');
    }
};

export const ensureBaseDirectories = async () => {
    const paths = [config.databaseDir, config.repoSandboxPath, config.deploymentPath, config.persistentPath, config.nginxConfDir, config.wwwPath];
    for (const p of paths) {
        try {
            await fs.mkdir(p, { recursive: true });
        } catch (e: any) {
            initLog.error({ action: 'base_dir_failed', path: p, err: e?.message }, `error creating path ${p}`);
        }
    }
    initLog.info({ action: 'base_directories_ensured', pathCount: paths.length }, 'base directories ensured');
};

export const handleSignals = (server: any) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        initLog.warn({ action: 'shutdown_started', signal }, `received ${signal}, shutting down gracefully`);
        cluster.stop();
        // Drop idle keep-alive sockets so server.close() isn't held open by the long keepAliveTimeout.
        server.closeIdleConnections?.();
        server.close(() => {
            initLog.info({ action: 'server_closed' }, 'server closed');
            exit(0);
        });
        // Backstop: never let a lingering connection block a systemd restart.
        setTimeout(() => exit(0), 8000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

export const registerCronJobs = () => {
    // Leader-only: renew certs approaching expiry.
    cron.schedule('*/30 * * * *', () => {
        initLog.debug({ action: 'cron_fired', job: 'cert_renewal', isLeader: cluster.isLeader() }, 'cert renewal cron fired');
        if (cluster.isLeader()) void leaderEnsureCerts();
    });
    // Leader-only: drive rolling self-update toward desiredNsmVersion.
    cron.schedule('* * * * *', () => {
        initLog.debug({ action: 'cron_fired', job: 'self_update', isLeader: cluster.isLeader() }, 'self-update cron fired');
        if (cluster.isLeader()) void runSelfUpdateRolloutIfLeader();
    });
    // Every node: sample per-project disk usage into the Prometheus gauge every 30 minutes.
    cron.schedule('*/30 * * * *', () => {
        initLog.debug({ action: 'cron_fired', job: 'disk_usage' }, 'disk usage cron fired');
        void collectDiskUsage().catch((e) => initLog.error({ action: 'disk_usage_failed', err: e?.message }, 'disk usage collection failed'));
    });
    initLog.info({ action: 'cron_registered', jobs: ['cert_renewal:*/30', 'self_update:*', 'disk_usage:*/30'] }, 'cron jobs registered');
};
