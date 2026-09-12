import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })), execStream: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getAllDesiredDeploymentsModel: vi.fn() }));
vi.mock('@/persistence/certPersistence', () => ({ getAllCertsModel: vi.fn() }));

import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { getAllCertsModel } from '@/persistence/certPersistence';
import { renderAllNginx } from '@/reconcile/nginxRender';

const mockExec = execSafe as unknown as Mock;
const mockDeps = getAllDesiredDeploymentsModel as unknown as Mock;
const mockCerts = getAllCertsModel as unknown as Mock;

const dep = (projectId: string, nginxConf: string, domains: string[] = []) => ({ projectId, nginxConf, generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', domains, services: [] });
const cert = (domain: string) => ({ domain, notAfter: Date.now() + 1e10 });

beforeEach(async () => {
    config.production = true;
    mockExec.mockClear();
    mockDeps.mockReset();
    mockCerts.mockReset();
    mockCerts.mockResolvedValue([]);
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

    it('defers a vhost until every one of its domains has an issued cert', async () => {
        mockDeps.mockResolvedValue([dep('pg_defer', 'server pg_defer', ['a.com', 'b.com'])]);
        mockCerts.mockResolvedValue([cert('a.com')]); // b.com not yet issued
        await renderAllNginx();
        await expect(fsp.readFile(`${config.nginxConfDir}/pg_defer.conf`, 'utf-8')).rejects.toBeTruthy();
    });

    it('writes the vhost once all its domains have certs', async () => {
        mockDeps.mockResolvedValue([dep('pg_write', 'server pg_write', ['a.com', 'b.com'])]);
        mockCerts.mockResolvedValue([cert('a.com'), cert('b.com')]);
        await renderAllNginx();
        expect(await fsp.readFile(`${config.nginxConfDir}/pg_write.conf`, 'utf-8')).toBe('server pg_write');
    });

    it('removes a previously-written conf when its cert-backed domain regresses', async () => {
        mockDeps.mockResolvedValue([dep('pg_regress', 'server pg_regress', ['a.com'])]);
        mockCerts.mockResolvedValue([cert('a.com')]);
        await renderAllNginx();
        expect(await fsp.readFile(`${config.nginxConfDir}/pg_regress.conf`, 'utf-8')).toBe('server pg_regress');
        mockCerts.mockResolvedValue([]); // cert gone
        await renderAllNginx();
        await expect(fsp.readFile(`${config.nginxConfDir}/pg_regress.conf`, 'utf-8')).rejects.toBeTruthy();
    });

    it('for a zero-downtime deployment, serves the ACTIVE conf and withholds the vhost until promoted', async () => {
        // Pending (not yet promoted): activeNginxConf undefined -> no vhost even though nginxConf is set.
        mockDeps.mockResolvedValue([{ ...dep('zd', 'PENDING', ['a.com']), zeroDowntime: true, activeNginxConf: undefined, activeDomains: undefined }]);
        mockCerts.mockResolvedValue([cert('a.com')]);
        await renderAllNginx();
        await expect(fsp.readFile(`${config.nginxConfDir}/zd.conf`, 'utf-8')).rejects.toBeTruthy();

        // Promoted: the ACTIVE conf is rendered, not the pending one.
        mockDeps.mockResolvedValue([{ ...dep('zd', 'PENDING2', ['a.com']), zeroDowntime: true, activeNginxConf: 'ACTIVE', activeDomains: ['a.com'] }]);
        await renderAllNginx();
        expect(await fsp.readFile(`${config.nginxConfDir}/zd.conf`, 'utf-8')).toBe('ACTIVE');
    });

    it('writes an http-01 challenge vhost for pending domains that lack a cert', async () => {
        mockDeps.mockResolvedValue([dep('c1', 'server c1', ['x.com'])]);
        mockCerts.mockResolvedValue([]);
        await renderAllNginx();
        const challenge = await fsp.readFile(`${config.nginxConfDir}/_nsm_http_challenge.conf`, 'utf-8');
        expect(challenge).toContain('listen 80;');
        expect(challenge).toContain('server_name x.com;');
        // The real vhost is still deferred until the cert exists.
        await expect(fsp.readFile(`${config.nginxConfDir}/c1.conf`, 'utf-8')).rejects.toBeTruthy();
    });

    it('strips legacy certbot-installer file references from frozen confs', async () => {
        const legacy = [
            'server {',
            '    ssl_certificate /etc/letsencrypt/live/a.com/fullchain.pem;',
            '    include /etc/letsencrypt/options-ssl-nginx.conf;',
            '    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;',
            '}',
        ].join('\n');
        mockDeps.mockResolvedValue([dep('pg_strip', legacy, ['a.com'])]);
        mockCerts.mockResolvedValue([cert('a.com')]);
        await renderAllNginx();
        const written = await fsp.readFile(`${config.nginxConfDir}/pg_strip.conf`, 'utf-8');
        expect(written).not.toContain('options-ssl-nginx.conf');
        expect(written).not.toContain('ssl-dhparams.pem');
        expect(written).toContain('ssl_certificate /etc/letsencrypt/live/a.com/fullchain.pem;');
    });
});
