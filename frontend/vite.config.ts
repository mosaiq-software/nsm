import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// API path prefixes proxied to the running daemon in dev. Keep these disjoint from client-side
// route paths (/, /p/*, /nodes, /status, /logs, /access) so the SPA and the API never collide.
const API_PREFIXES = ['/projects', '/project', '/project-instance', '/cluster', '/observability', '/allowed-entities', '/auth', '/login', '/logout', '/deploy', '/deployweb', '/healthz', '/metrics'];

const daemon = process.env.NSM_API_TARGET || 'http://127.0.0.1:1025';

export default defineConfig({
    // Load env from the repo root, shared with the daemon. Only VITE_-prefixed vars are exposed
    // to the client bundle, so backend-only values (secrets, cluster config) stay server-side.
    envDir: path.resolve(__dirname, '..'),
    plugins: [react()],
    resolve: {
        alias: [
            // Consume nsm/common TS directly (no build step), mirroring the daemon's tsconfig paths.
            { find: /^@mosaiq\/nsm-common\/(.*)$/, replacement: path.resolve(__dirname, '../common/src/$1') },
            { find: '@mosaiq/nsm-common', replacement: path.resolve(__dirname, '../common/src/index.ts') },
            { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, 'src/$1') },
        ],
    },
    server: {
        port: 5173,
        proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, { target: daemon, changeOrigin: true }])),
    },
    build: {
        // Default to the repo-local dev www dir (matches root .env NSM_WWW_PATH). Bootstrap sets
        // NSM_UI_OUT to the real NSM_WWW_PATH on the leader.
        outDir: process.env.NSM_UI_OUT || '../.devdata/www',
        emptyOutDir: true,
    },
});
