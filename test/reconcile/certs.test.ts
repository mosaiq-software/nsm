import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: 'notAfter=Dec 31 23:59:59 2035 GMT', code: 0 })), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));
vi.mock('@/persistence/certPersistence', () => ({ getAllCertsModel: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getAllDesiredDeploymentsModel: vi.fn() }));
vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true } }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { getAllCertsModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { cluster } from '@/cluster/node';
import { syncCertsToDisk, leaderEnsureCerts } from '@/reconcile/certs';
import { OpType } from '@mosaiq/nsm-common/clusterOps';

const mockCerts = getAllCertsModel as unknown as Mock;
const mockDeps = getAllDesiredDeploymentsModel as unknown as Mock;
const mockStream = execStream as unknown as Mock;
const mockPropose = cluster.propose as unknown as Mock;

beforeEach(async () => {
    config.production = true;
    mockCerts.mockReset();
    mockDeps.mockReset();
    mockStream.mockClear();
    mockPropose.mockClear();
    await fsp.rm(config.letsencryptLiveDir, { recursive: true, force: true });
});
afterEach(() => {
    config.production = false;
    vi.restoreAllMocks();
});

describe('syncCertsToDisk', () => {
    it('writes cert material to disk, skipping unchanged files on re-sync', async () => {
        mockCerts.mockResolvedValue([{ domain: 'a.com', fullchainPem: 'FC', privkeyPem: 'PK', notAfter: Date.now() + 1e10 }]);
        await syncCertsToDisk();
        const dir = `${config.letsencryptLiveDir}/a.com`;
        expect(await fsp.readFile(`${dir}/fullchain.pem`, 'utf-8')).toBe('FC');
        expect(await fsp.readFile(`${dir}/privkey.pem`, 'utf-8')).toBe('PK');

        // Re-sync with identical material must not rewrite the file (mtime stays put).
        const before = (await fsp.stat(`${dir}/fullchain.pem`)).mtimeMs;
        await new Promise((r) => setTimeout(r, 15));
        await syncCertsToDisk();
        const after = (await fsp.stat(`${dir}/fullchain.pem`)).mtimeMs;
        expect(after).toBe(before);
    });
});

describe('leaderEnsureCerts', () => {
    it('skips domains whose cert is still valid', async () => {
        mockDeps.mockResolvedValue([{ domains: ['valid.com'], projectId: 'p', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', services: [] }]);
        mockCerts.mockResolvedValue([{ domain: 'valid.com', fullchainPem: 'x', privkeyPem: 'y', notAfter: Date.now() + 60 * 24 * 60 * 60 * 1000 }]);
        await leaderEnsureCerts();
        expect(mockStream).not.toHaveBeenCalled();
        expect(mockPropose).not.toHaveBeenCalled();
    });

    it('obtains and replicates a cert for an expiring/missing domain', async () => {
        mockDeps.mockResolvedValue([{ domains: ['new.com'], projectId: 'p', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', services: [] }]);
        mockCerts.mockResolvedValue([]);
        const dir = `${config.letsencryptLiveDir}/new.com`;
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(`${dir}/fullchain.pem`, 'FULL');
        await fsp.writeFile(`${dir}/privkey.pem`, 'PRIV');
        await leaderEnsureCerts();
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('certbot certonly'), expect.any(Number));
        expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({ type: OpType.UPSERT_CERT, cert: expect.objectContaining({ domain: 'new.com', fullchainPem: 'FULL', privkeyPem: 'PRIV' }) }));
    });
});
