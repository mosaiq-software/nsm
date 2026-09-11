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
delete process.env.VIP;

set('PRODUCTION', 'false');
set('NODE_ID', 'test-node');
// Default tests to leader so controllers that call cluster.propose work; individual tests
// override via vi.stubEnv('NSM_ROLE', 'follower').
set('NSM_ROLE', 'leader');
set('BIND_ADDRESS', '127.0.0.1');
set('API_PORT', '16000');
set('LEADER_ADDRESS', 'http://127.0.0.1:16000');
set('INTERNAL_DOMAIN', 'nsm.internal');
set('CLUSTER_SECRET', 'test-secret');
set('FRONTEND_URL', 'http://localhost:3000');
set('DATABASE_DIR', path.join(tmpRoot, 'db'));
set('DATABASE_NAME', 'test.sqlite');
set('DATABASE_LOGGING', 'false');
set('REPO_SANDBOX_PATH', path.join(tmpRoot, 'sandbox'));
set('DEPLOYMENT_PATH', path.join(tmpRoot, 'apps'));
set('PERSISTENT_PATH', path.join(tmpRoot, 'persistent'));
set('NGINX_CONF_DIR', path.join(tmpRoot, 'nginx'));
set('NSM_WWW_PATH', path.join(tmpRoot, 'www'));
set('LETSENCRYPT_LIVE_DIR', path.join(tmpRoot, 'letsencrypt'));

// Expose the per-file tmp root for helpers that need scratch space.
(globalThis as any).__NSM_TMP__ = tmpRoot;
