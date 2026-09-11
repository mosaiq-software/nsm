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

export interface GithubOwner {
    login: string;
    type: string; // 'User' | 'Organization'
    avatarUrl: string;
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

const ghHeaders = (bearer: string): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nsm',
    Authorization: `Bearer ${bearer}`,
});

// Authenticated as the App itself (App JWT). Used for installation discovery and token minting.
const ghAppRequest = async (apiPath: string, init?: { method?: string; body?: string }): Promise<Response> => {
    return fetch(`${GH_API}${apiPath}`, {
        method: init?.method || 'GET',
        body: init?.body,
        headers: ghHeaders(signAppJwt()),
    });
};

// Authenticated as an installation (installation access token). Used to read repos/branches.
const ghInstallationRequest = async (token: string, apiPath: string): Promise<Response> => {
    return fetch(`${GH_API}${apiPath}`, { headers: ghHeaders(token) });
};

const installationCache = new Map<string, string>();
// owner (lowercased) -> installation id, populated by listing the App's installations.
const ownerInstallationCache = new Map<string, string>();

interface RawInstallation {
    id: number;
    account: { login: string; type: string; avatar_url: string } | null;
}

// List every installation of this GitHub App, following pagination. Also refreshes the
// owner -> installation-id cache so repo/branch lookups can resolve an owner without a repo.
const fetchInstallations = async (): Promise<RawInstallation[]> => {
    const all: RawInstallation[] = [];
    for (let page = 1; ; page++) {
        const res = await ghAppRequest(`/app/installations?per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`Failed to list GitHub App installations: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as RawInstallation[];
        all.push(...data);
        if (data.length < 100) break;
    }
    for (const inst of all) {
        if (inst.account) ownerInstallationCache.set(inst.account.login.toLowerCase(), String(inst.id));
    }
    return all;
};

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

// Resolve the installation id for an owner with no specific repo (needed to list the owner's repos).
const resolveInstallationIdForOwner = async (owner: string): Promise<string> => {
    const key = owner.toLowerCase();
    if (!ownerInstallationCache.has(key)) await fetchInstallations();
    const id = ownerInstallationCache.get(key);
    if (!id) throw new Error(`No GitHub App installation found for '${owner}'`);
    return id;
};

const tokenCache = new Map<string, CloneToken>();

// Mint an installation access token (~1h), cached by key until it nears expiry. When `repositories`
// is omitted the token can access every repo in the installation (used for listing).
const mintTokenForInstallation = async (cacheKey: string, installationId: string, repositories?: string[]): Promise<CloneToken> => {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached;
    const res = await ghAppRequest(`/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        body: repositories ? JSON.stringify({ repositories }) : undefined,
    });
    if (!res.ok) throw new Error(`Failed to mint installation token for ${cacheKey}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { token: string; expires_at: string };
    const result: CloneToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
    tokenCache.set(cacheKey, result);
    return result;
};

// Leader-only: mint a repo-scoped installation access token (~1h). Cached until it nears expiry.
export const mintInstallationToken = async (owner: string, repo: string): Promise<CloneToken> => {
    const installationId = await resolveInstallationId(owner, repo);
    return mintTokenForInstallation(`${owner}/${repo}`, installationId, [repo]);
};

// Leader-only: the owners (users/orgs) that have installed the App, for create-project suggestions.
export const listInstallationOwners = async (): Promise<GithubOwner[]> => {
    const installs = await fetchInstallations();
    return installs
        .filter((i) => i.account)
        .map((i) => ({ login: i.account!.login, type: i.account!.type, avatarUrl: i.account!.avatar_url }));
};

// Leader-only: the repositories the App can access for a given owner (sorted, names only).
export const listInstallationRepos = async (owner: string): Promise<string[]> => {
    const installationId = await resolveInstallationIdForOwner(owner);
    const token = await mintTokenForInstallation(`installation:${installationId}`, installationId);
    const names: string[] = [];
    for (let page = 1; ; page++) {
        const res = await ghInstallationRequest(token.token, `/installation/repositories?per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`Failed to list repos for ${owner}: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as { repositories: Array<{ name: string }> };
        for (const r of data.repositories) names.push(r.name);
        if (data.repositories.length < 100) break;
    }
    return names.sort((a, b) => a.localeCompare(b));
};

// Leader-only: the branch names of a repo the App can access.
export const listRepoBranches = async (owner: string, repo: string): Promise<string[]> => {
    const token = await mintInstallationToken(owner, repo);
    const names: string[] = [];
    for (let page = 1; ; page++) {
        const res = await ghInstallationRequest(token.token, `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`Failed to list branches for ${owner}/${repo}: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as Array<{ name: string }>;
        for (const b of data) names.push(b.name);
        if (data.length < 100) break;
    }
    return names;
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
