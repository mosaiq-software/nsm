import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

// githubApp.ts pulls config, cluster role, and the leader client; mock all three so we can drive
// role and inspect the token request without a real cluster.
const h = vi.hoisted(() => ({
    cfg: { githubApp: { appId: '12345', privateKeyPath: '', installationId: '' } },
    state: { isLeader: true },
    postToLeader: vi.fn(),
}));

vi.mock('@/config', () => ({ config: h.cfg }));
vi.mock('@/cluster/node', () => ({ cluster: { isLeader: () => h.state.isLeader } }));
vi.mock('@/cluster/leaderClient', () => ({ postToLeader: h.postToLeader }));

const jsonRes = (ok: boolean, body: unknown) => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
});

const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('githubApp', () => {
    beforeAll(() => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const dir = mkdtempSync(path.join(os.tmpdir(), 'nsm-test-'));
        const keyPath = path.join(dir, 'key.pem');
        writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }) as string);
        h.cfg.githubApp.privateKeyPath = keyPath;
    });

    beforeEach(() => {
        vi.resetModules();
        h.state.isLeader = true;
        h.cfg.githubApp.installationId = '';
        h.postToLeader.mockReset();
        global.fetch = vi.fn() as unknown as typeof fetch;
    });

    it('signs a valid App JWT, resolves the installation, and mints a repo-scoped token', async () => {
        const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock
            .mockResolvedValueOnce(jsonRes(true, { id: 999 }))
            .mockResolvedValueOnce(jsonRes(true, { token: 't1', expires_at: futureIso() }));

        const { mintInstallationToken } = await import('@/utils/githubApp');
        const out = await mintInstallationToken('owner', 'repo');
        expect(out.token).toBe('t1');
        expect(out.expiresAt).toBeGreaterThan(Date.now());

        // Resolve then mint, hitting the expected endpoints.
        expect(fetchMock.mock.calls[0][0]).toContain('/repos/owner/repo/installation');
        expect(fetchMock.mock.calls[1][0]).toContain('/app/installations/999/access_tokens');
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ repositories: ['repo'] });

        // The Authorization header is a 3-part RS256 JWT issued by the App id.
        const auth: string = fetchMock.mock.calls[0][1].headers.Authorization;
        const jwt = auth.replace(/^Bearer /, '');
        const parts = jwt.split('.');
        expect(parts).toHaveLength(3);
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        expect(header.alg).toBe('RS256');
        expect(payload.iss).toBe('12345');
        expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it('reuses a cached token instead of minting again', async () => {
        const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock
            .mockResolvedValueOnce(jsonRes(true, { id: 999 }))
            .mockResolvedValueOnce(jsonRes(true, { token: 't1', expires_at: futureIso() }));

        const { mintInstallationToken } = await import('@/utils/githubApp');
        await mintInstallationToken('o', 'r');
        await mintInstallationToken('o', 'r');
        // One resolve + one mint total; the second call is served from cache.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uses the configured installation id when present', async () => {
        h.cfg.githubApp.installationId = '4242';
        const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock.mockResolvedValueOnce(jsonRes(true, { token: 't1', expires_at: futureIso() }));

        const { mintInstallationToken } = await import('@/utils/githubApp');
        await mintInstallationToken('o', 'r');
        // No installation lookup; straight to the configured id's token endpoint.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/app/installations/4242/access_tokens');
    });

    it('on a follower, fetches the token from the leader instead of minting', async () => {
        h.state.isLeader = false;
        h.postToLeader.mockResolvedValue({ token: 'from-leader', expiresAt: Date.now() + 3600_000 });

        const { getCloneToken } = await import('@/utils/githubApp');
        const out = await getCloneToken('o', 'r');
        expect(out.token).toBe('from-leader');
        expect(h.postToLeader).toHaveBeenCalledWith('/cluster/git-token', { repoOwner: 'o', repoName: 'r' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('withCloneCredentials exposes the token only via a GIT_ASKPASS helper and cleans up', async () => {
        const { withCloneCredentials } = await import('@/utils/githubApp');
        let askpassPath = '';
        const result = await withCloneCredentials('secret-token', async (envPrefix) => {
            expect(envPrefix).toContain('GIT_TERMINAL_PROMPT=0');
            const match = envPrefix.match(/GIT_ASKPASS=(\S+)/);
            askpassPath = match![1];
            const printed = execFileSync('sh', [askpassPath]).toString();
            expect(printed).toBe('secret-token');
            return 'done';
        });
        expect(result).toBe('done');
        // Temp credentials are removed after the callback resolves.
        expect(existsSync(askpassPath)).toBe(false);
    });
});
