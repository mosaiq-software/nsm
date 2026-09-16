import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: 'notAfter=Dec 31 23:59:59 2035 GMT', code: 0 })), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));
vi.mock('@/persistence/certPersistence', () => ({ getAllCertsModel: vi.fn(), upsertCertModel: vi.fn(), deleteCertModel: vi.fn() }));
vi.mock('@/persistence/desiredDeploymentPersistence', () => ({ getAllDesiredDeploymentsModel: vi.fn() }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { getAllCertsModel, upsertCertModel, deleteCertModel } from '@/persistence/certPersistence';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { leaderEnsureCerts, removeCertsForDomains } from '@/reconcile/certs';

const mockCerts = getAllCertsModel as unknown as Mock;
const mockUpsertCert = upsertCertModel as unknown as Mock;
const mockDeleteCert = deleteCertModel as unknown as Mock;
const mockDeps = getAllDesiredDeploymentsModel as unknown as Mock;
const mockStream = execStream as unknown as Mock;

beforeEach(async () => {
    config.production = true;
    mockCerts.mockReset();
    mockUpsertCert.mockReset();
    mockDeleteCert.mockReset();
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

    it('obtains a cert for an expiring/missing domain and records its expiry locally (no replication)', async () => {
        mockDeps.mockResolvedValue([{ domains: ['new.com'], projectId: 'p', generation: 1, assignedNodeId: 'n', repoOwner: 'o', repoName: 'r', timeout: 1, logId: 'l', dotenv: '', compose: '', nginxConf: '', services: [] }]);
        mockCerts.mockResolvedValue([]);
        await leaderEnsureCerts();
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('certbot certonly'), expect.any(Number));
        // Only expiry is recorded in the leader-local DB (PEMs stay on disk, read by nginx, unreplicated).
        expect(mockUpsertCert).toHaveBeenCalledWith(expect.objectContaining({ domain: 'new.com', notAfter: expect.any(Number) }));
        const [[recorded]] = mockUpsertCert.mock.calls;
        expect(recorded.privkeyPem).toBeUndefined();
    });
});

describe('removeCertsForDomains', () => {
    it('runs certbot delete and drops the local record for each domain', async () => {
        await removeCertsForDomains(['a.com', 'b.com']);
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('certbot delete --cert-name a.com'), expect.any(Number));
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('certbot delete --cert-name b.com'), expect.any(Number));
        expect(mockDeleteCert).toHaveBeenCalledWith('a.com');
        expect(mockDeleteCert).toHaveBeenCalledWith('b.com');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await removeCertsForDomains(['a.com']);
        expect(mockStream).not.toHaveBeenCalled();
        expect(mockDeleteCert).not.toHaveBeenCalled();
    });
});
