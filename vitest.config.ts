import { defineConfig } from 'vitest/config';
import * as path from 'path';

const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
    resolve: {
        alias: [
            { find: /^@mosaiq\/nsm-common$/, replacement: r('common/src/index.ts') },
            { find: /^@mosaiq\/nsm-common\/(.*)$/, replacement: r('common/src/$1') },
            { find: /^@\/(.*)$/, replacement: r('src/$1') },
        ],
    },
    test: {
        environment: 'node',
        // Isolate each test file in its own process: real TCP servers + SQLite files must not
        // collide, and module-level singletons (config, sequelize, cluster) reset per file.
        pool: 'forks',
        globals: true,
        setupFiles: ['test/setup.ts'],
        hookTimeout: 20000,
        testTimeout: 20000,
        include: ['test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**', 'common/**'],
            exclude: ['src/index.ts', '**/*.d.ts'],
            reporter: ['text', 'html'],
        },
    },
});
