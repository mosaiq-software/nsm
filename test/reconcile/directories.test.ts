import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import { config } from '@/config';
import { ensureDirectories } from '@/reconcile/directories';

beforeEach(() => {
    config.production = true;
});
afterEach(() => {
    config.production = false;
});

describe('ensureDirectories', () => {
    it('creates directories under persistentPath and returns their full paths', async () => {
        const map = { 'p1._._.Volume': { relPath: '/data/uploads' } };
        const full = await ensureDirectories(map);
        const expected = `${config.persistentPath}/data/uploads`;
        expect(full['p1._._.Volume'].fullPath).toBe(expected);
        const stat = await fsp.stat(expected);
        expect(stat.isDirectory()).toBe(true);
    });

    it('returns mock paths in non-production without touching disk', async () => {
        config.production = false;
        const full = await ensureDirectories({ k: { relPath: 'x/y' } });
        expect(full.k.fullPath).toBe('/mock/persistent/x/y');
    });
});
