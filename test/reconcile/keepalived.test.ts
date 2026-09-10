import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

const template = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeFs = require('fs');
    return nodeFs.readFileSync('deploy/keepalived.conf.tmpl', 'utf-8') as string;
});

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('fs/promises', () => ({
    readFile: vi.fn(async (p: any) => {
        const key = String(p);
        if (key.endsWith('.tmpl')) return template;
        if (store.has(key)) return store.get(key);
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
    }),
    writeFile: vi.fn(async (p: any, contents: string) => {
        store.set(String(p), contents);
    }),
    mkdir: vi.fn(async () => undefined),
}));
vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })), execStream: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import * as fsp from 'fs/promises';
import { ensureKeepalived } from '@/reconcile/keepalived';

const mockExec = execSafe as unknown as Mock;
const mockWrite = fsp.writeFile as unknown as Mock;
const CONF = '/etc/keepalived/keepalived.conf';

// priority offset must match the implementation for a deterministic assertion.
const offset = (nodeId: string) => {
    let h = 0;
    for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) % 50;
    return h;
};

beforeEach(() => {
    config.production = true;
    config.vip = '10.0.0.100';
    config.vrrpIface = 'eth0';
    config.vrrpRouterId = 51;
    config.vrrpPass = 'secret';
    store.clear();
    mockExec.mockClear();
    mockWrite.mockClear();
});
afterEach(() => {
    config.production = false;
    config.vip = '';
});

describe('ensureKeepalived', () => {
    it('substitutes template variables, writes config, and reloads', async () => {
        await ensureKeepalived();
        const written = store.get(CONF)!;
        expect(written).toContain('10.0.0.100/24 dev eth0');
        expect(written).toContain('virtual_router_id 51');
        expect(written).toContain('auth_pass secret');
        expect(written).toContain(`priority ${100 + offset(config.nodeId)}`);
        expect(written).not.toContain('{{');
        expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('keepalived'), expect.any(Number));
    });

    it('does not rewrite or reload when the config is unchanged', async () => {
        await ensureKeepalived();
        mockWrite.mockClear();
        mockExec.mockClear();
        await ensureKeepalived();
        expect(mockWrite).not.toHaveBeenCalled();
        expect(mockExec).not.toHaveBeenCalled();
    });

    it('skips entirely when no VIP is configured', async () => {
        config.vip = '';
        await ensureKeepalived();
        expect(mockWrite).not.toHaveBeenCalled();
    });
});
