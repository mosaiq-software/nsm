import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })), execStream: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getAllDesiredDeploymentsModel: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { renderAllNginx } from '@/reconcile/nginxRender';

const mockExec = execSafe as unknown as Mock;
const mockDeps = getAllDesiredDeploymentsModel as unknown as Mock;

const dep = (projectId: string, nginxConf: string) => ({ projectId, nginxConf, generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', domains: [], services: [] });

beforeEach(async () => {
    config.production = true;
    mockExec.mockClear();
    mockDeps.mockReset();
    await fsp.rm(config.nginxConfDir, { recursive: true, force: true });
});
afterEach(() => {
    config.production = false;
});

describe('renderAllNginx', () => {
    it('writes one conf per deployment and reports changed', async () => {
        mockDeps.mockResolvedValue([dep('p1', 'server p1'), dep('p2', 'server p2')]);
        const { changed } = await renderAllNginx();
        expect(changed).toBe(true);
        expect(await fsp.readFile(`${config.nginxConfDir}/p1.conf`, 'utf-8')).toBe('server p1');
        expect(await fsp.readFile(`${config.nginxConfDir}/p2.conf`, 'utf-8')).toBe('server p2');
        // nginx -t + reload gated on changed && production; sudo-prefixed in production
        expect(mockExec).toHaveBeenCalledWith('sudo -n nginx -t', expect.any(Number));
        expect(mockExec).toHaveBeenCalledWith('sudo -n nginx -s reload', expect.any(Number));
    });

    it('reports no change on a second identical render', async () => {
        mockDeps.mockResolvedValue([dep('p1', 'server p1')]);
        await renderAllNginx();
        mockExec.mockClear();
        const { changed } = await renderAllNginx();
        expect(changed).toBe(false);
        expect(mockExec).not.toHaveBeenCalled();
    });

    it('removes stale conf files for deployments that disappeared', async () => {
        mockDeps.mockResolvedValueOnce([dep('p1', 'a'), dep('p2', 'b')]);
        await renderAllNginx();
        mockDeps.mockResolvedValueOnce([dep('p1', 'a')]);
        const { changed } = await renderAllNginx();
        expect(changed).toBe(true);
        await expect(fsp.readFile(`${config.nginxConfDir}/p2.conf`, 'utf-8')).rejects.toBeTruthy();
    });

    it('does not reload when nginx -t fails', async () => {
        mockDeps.mockResolvedValue([dep('p1', 'server p1')]);
        mockExec.mockImplementation(async (cmd: string) => (cmd === 'sudo -n nginx -t' ? { out: 'bad', code: 1 } : { out: '', code: 0 }));
        const { changed } = await renderAllNginx();
        expect(changed).toBe(false);
        expect(mockExec).not.toHaveBeenCalledWith('sudo -n nginx -s reload', expect.any(Number));
    });
});
