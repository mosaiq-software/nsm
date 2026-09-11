import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';

export interface CloneToken {
    token: string;
    expiresAt: number;
}

const GH_API = 'https://api.github.com';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

// A GitHub App authenticates as itself with a short-lived JWT (RS256) signed by the App private
// key. Signed with Node's built-in crypto so no extra dependency is needed.
const signAppJwt = (): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // iat is backdated 60s to tolerate clock skew; exp must be <= 10 min per GitHub.
    const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.githubApp.appId }));
    const signingInput = `${header}.${payload}`;
    const privateKey = readFileSync(config.githubApp.privateKeyPath, 'utf-8');
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
    return `${signingInput}.${b64url(signature)}`;
};

const ghAppRequest = async (apiPath: string, init?: { method?: string; body?: string }): Promise<Response> => {
    return fetch(`${GH_API}${apiPath}`, {
        method: init?.method || 'GET',
        body: init?.body,
        headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'nsm',
            Authorization: `Bearer ${signAppJwt()}`,
        },
    });
};

const installationCache = new Map<string, string>();

const resolveInstallationId = async (owner: string, repo: string): Promise<string> => {
    if (config.githubApp.installationId) return config.githubApp.installationId;
    const cached = installationCache.get(owner);
    if (cached) return cached;
    const res = await ghAppRequest(`/repos/${owner}/${repo}/installation`);
    if (!res.ok) throw new Error(`Failed to resolve GitHub App installation for ${owner}/${repo}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { id: number };
    const id = String(data.id);
    installationCache.set(owner, id);
    return id;
};

const tokenCache = new Map<string, CloneToken>();

// Leader-only: mint a repo-scoped installation access token (~1h). Cached until it nears expiry.
export const mintInstallationToken = async (owner: string, repo: string): Promise<CloneToken> => {
    const key = `${owner}/${repo}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached;

    const installationId = await resolveInstallationId(owner, repo);
    const res = await ghAppRequest(`/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        body: JSON.stringify({ repositories: [repo] }),
    });
    if (!res.ok) throw new Error(`Failed to mint installation token for ${key}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { token: string; expires_at: string };
    const result: CloneToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
    tokenCache.set(key, result);
    return result;
};

// Role-aware: the leader mints locally; a follower asks the leader for a fresh token so the App
// private key never leaves the leader.
export const getCloneToken = async (owner: string, repo: string): Promise<CloneToken> => {
    if (cluster.isLeader()) return mintInstallationToken(owner, repo);
    const res = await postToLeader<CloneToken>('/cluster/git-token', { repoOwner: owner, repoName: repo });
    if (!res?.token) throw new Error(`Leader did not return a git token for ${owner}/${repo}`);
    return res;
};

// Runs `fn` with the token exposed only through a GIT_ASKPASS helper backed by a 0600 temp file, so
// the token never appears in argv or logs. `fn` receives an env prefix to prepend to the git command.
export const withCloneCredentials = async <T>(token: string, fn: (envPrefix: string) => Promise<T>): Promise<T> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nsm-git-'));
    const tokenFile = path.join(dir, 'token');
    const askpass = path.join(dir, 'askpass.sh');
    try {
        await fs.writeFile(tokenFile, token, { mode: 0o600 });
        await fs.writeFile(askpass, `#!/bin/sh\ncat ${tokenFile}\n`, { mode: 0o700 });
        return await fn(`GIT_ASKPASS=${askpass} GIT_TERMINAL_PROMPT=0`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
};
