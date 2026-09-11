import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: 'notAfter=Dec 31 23:59:59 2035 GMT', code: 0 })), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));
vi.mock('@/persistence/certPersistence', () => ({ getAllCertsModel: vi.fn(), upsertCertModel: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getAllDesiredDeploymentsModel: vi.fn() }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { getAllCertsModel, upsertCertModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { leaderEnsureCerts } from '@/reconcile/certs';

const mockCerts = getAllCertsModel as unknown as Mock;
const mockUpsertCert = upsertCertModel as unknown as Mock;
const mockDeps = getAllDesiredDeploymentsModel as unknown as Mock;
const mockStream = execStream as unknown as Mock;

beforeEach(async () => {
    config.production = true;
    mockCerts.mockReset();
    mockUpsertCert.mockReset();
    mockDeps.mockReset();
    mockStream.mockClear();
    await fsp.rm(config.letsencryptLiveDir, { recursive: true, force: true });
});
afterEach(() => {
    config.production = false;
    vi.restoreAllMocks();
});

describe('leaderEnsureCerts', () => {
    it('skips domains whose cert is still valid', async () => {
        mockDeps.mockResolvedValue([{ domains: ['valid.com'], projectId: 'p', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', services: [] }]);
        mockCerts.mockResolvedValue([{ domain: 'valid.com', fullchainPem: 'x', privkeyPem: 'y', notAfter: Date.now() + 60 * 24 * 60 * 60 * 1000 }]);
        await leaderEnsureCerts();
        expect(mockStream).not.toHaveBeenCalled();
    });

    it('obtains a cert for an expiring/missing domain and records it locally (no replication)', async () => {
        mockDeps.mockResolvedValue([{ domains: ['new.com'], projectId: 'p', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', services: [] }]);
        mockCerts.mockResolvedValue([]);
        const dir = `${config.letsencryptLiveDir}/new.com`;
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(`${dir}/fullchain.pem`, 'FULL');
        await fsp.writeFile(`${dir}/privkey.pem`, 'PRIV');
        await leaderEnsureCerts();
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('certbot certonly'), expect.any(Number));
        // Cert material is recorded in the leader-local DB, not proposed/replicated.
        expect(mockUpsertCert).toHaveBeenCalledWith(expect.objectContaining({ domain: 'new.com', fullchainPem: 'FULL', privkeyPem: 'PRIV' }));
    });
});
