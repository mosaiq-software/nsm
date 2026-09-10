// Runs before any test module is evaluated. Because src/config.ts and src/utils/dbHelper.ts
// read process.env at import time, we must establish a sane test environment here first.
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nsm-test-${process.pid}-`));

// Force-control the environment so the suite is deterministic regardless of any inherited
// shell env (e.g. leftover exports from manual runs). Individual tests override via vi.stubEnv.
const set = (k: string, v: string) => {
    process.env[k] = v;
};

// Clear anything that could steer the daemon into a non-test mode.
delete process.env.NSM_BOOTSTRAP;
delete process.env.VIP;

set('PRODUCTION', 'false');
set('NODE_ID', 'test-node');
set('BIND_ADDRESS', '127.0.0.1');
set('API_PORT', '16000');
set('RAFT_PORT', '16001');
set('CLUSTER_SECRET', 'test-secret');
set('FRONTEND_URL', 'http://localhost:3000');
set('DATABASE_DIR', path.join(tmpRoot, 'db'));
set('DATABASE_NAME', 'test.sqlite');
set('DATABASE_LOGGING', 'false');
set('RAFT_DATA_DIR', path.join(tmpRoot, 'raft'));
set('REPO_SANDBOX_PATH', path.join(tmpRoot, 'sandbox'));
set('DEPLOYMENT_PATH', path.join(tmpRoot, 'apps'));
set('PERSISTENT_PATH', path.join(tmpRoot, 'persistent'));
set('NGINX_CONF_DIR', path.join(tmpRoot, 'nginx'));
set('NSM_WWW_PATH', path.join(tmpRoot, 'www'));
set('LETSENCRYPT_LIVE_DIR', path.join(tmpRoot, 'letsencrypt'));
set('CLUSTER_FILE_PATH', path.join(tmpRoot, 'cluster.json'));
// Fast, deterministic raft timers for integration tests.
set('RAFT_ELECTION_MIN_MS', '150');
set('RAFT_ELECTION_MAX_MS', '300');
set('RAFT_HEARTBEAT_MS', '50');

// Expose the per-file tmp root for helpers that need scratch space.
(globalThis as any).__NSM_TMP__ = tmpRoot;
