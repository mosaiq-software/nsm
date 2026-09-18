import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sodium from 'libsodium-wrappers';
import { config } from '@/config';
import { cluster } from '@/cluster/node';
import { postToLeader } from '@/cluster/leaderClient';

export interface CloneToken {
    token: string;
    expiresAt: number;
}

export interface GithubOwner {
    id: string; // GitHub numeric account id (stable across login renames)
    login: string;
    type: string; // 'User' | 'Organization'
    avatarUrl: string;
}

export interface GithubMember {
    id: string;
    login: string;
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

// Authenticated as an installation (installation access token). Used to read repos/branches and to
// write repo secrets/contents (with a method + body).
const ghInstallationRequest = async (token: string, apiPath: string, init?: { method?: string; body?: string }): Promise<Response> => {
    return fetch(`${GH_API}${apiPath}`, {
        method: init?.method || 'GET',
        body: init?.body,
        headers: ghHeaders(token),
    });
};

const installationCache = new Map<string, string>();
// owner (lowercased) -> installation id, populated by listing the App's installations.
const ownerInstallationCache = new Map<string, string>();

interface RawInstallation {
    id: number;
    account: { id: number; login: string; type: string; avatar_url: string } | null;
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
    if (!res.ok) {
        const err = new Error(`Failed to resolve GitHub App installation for ${owner}/${repo}: ${res.status} ${await res.text()}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
    }
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
    if (!res.ok) {
        const err = new Error(`Failed to mint installation token for ${cacheKey}: ${res.status} ${await res.text()}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    const result: CloneToken = { token: data.token, expiresAt: Date.parse(data.expires_at) };
    tokenCache.set(cacheKey, result);
    return result;
};

// A repo-access failure (422 "not accessible to the parent installation", or 404) means the App is
// simply not granted this repo. Surface an actionable message instead of a raw GitHub status.
const isRepoAccessStatus = (status?: number): boolean => status === 422 || status === 404;
const repoAccessError = (owner: string, repo: string): Error =>
    new Error(
        `GitHub App has no access to ${owner}/${repo}. Add the repository to the App installation ` +
            `(GitHub > Settings > Applications > your NSM App > Configure > Repository access), or verify the repo name.`
    );

// Leader-only: mint a repo-scoped installation access token (~1h). Cached until it nears expiry.
export const mintInstallationToken = async (owner: string, repo: string): Promise<CloneToken> => {
    const attempt = async () => mintTokenForInstallation(`${owner}/${repo}`, await resolveInstallationId(owner, repo), [repo]);
    try {
        return await attempt();
    } catch (e: any) {
        if (!isRepoAccessStatus(e?.status)) throw e;
        // Possibly a stale owner->installation mapping (App reinstalled): drop the cache and re-resolve
        // once. If it still fails on access, the App genuinely lacks this repo.
        installationCache.delete(owner);
        try {
            return await attempt();
        } catch (e2: any) {
            if (isRepoAccessStatus(e2?.status)) throw repoAccessError(owner, repo);
            throw e2;
        }
    }
};

// Leader-only: the owners (users/orgs) that have installed the App, for create-project suggestions
// and team discovery.
export const listInstallationOwners = async (): Promise<GithubOwner[]> => {
    const installs = await fetchInstallations();
    return installs
        .filter((i) => i.account)
        .map((i) => ({ id: String(i.account!.id), login: i.account!.login, type: i.account!.type, avatarUrl: i.account!.avatar_url }));
};

interface RawMember {
    id: number;
    login: string;
    avatar_url: string;
}

// Leader-only: list the members of an org via an installation token. Requires the App to be granted
// the "Organization members: read" permission on the org. Paginated.
export const listOrgMembers = async (org: string): Promise<GithubMember[]> => {
    const installationId = await resolveInstallationIdForOwner(org);
    const token = await mintTokenForInstallation(`installation:${installationId}`, installationId);
    const members: GithubMember[] = [];
    for (let page = 1; ; page++) {
        const res = await ghInstallationRequest(token.token, `/orgs/${org}/members?per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`Failed to list members for ${org}: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as RawMember[];
        for (const m of data) members.push({ id: String(m.id), login: m.login, avatarUrl: m.avatar_url });
        if (data.length < 100) break;
    }
    return members;
};

// Leader-only: the logins of an org's owners (admins), who get absolute permissions in their team.
export const listOrgOwners = async (org: string): Promise<GithubMember[]> => {
    const installationId = await resolveInstallationIdForOwner(org);
    const token = await mintTokenForInstallation(`installation:${installationId}`, installationId);
    const owners: GithubMember[] = [];
    for (let page = 1; ; page++) {
        const res = await ghInstallationRequest(token.token, `/orgs/${org}/members?role=admin&per_page=100&page=${page}`);
        if (!res.ok) throw new Error(`Failed to list owners for ${org}: ${res.status} ${await res.text()}`);
        const data = (await res.json()) as RawMember[];
        for (const m of data) owners.push({ id: String(m.id), login: m.login, avatarUrl: m.avatar_url });
        if (data.length < 100) break;
    }
    return owners;
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

// ===== Managed CI/CD provisioning (leader-only) =====
// These helpers write to a repo (secrets + workflow file) using a repo-scoped installation token.
// They require the App to be granted "Secrets: write", "Contents: write" and "Workflows: write".

// PUT a repository Actions secret. GitHub requires the value to be encrypted with the repo's public
// key using a libsodium sealed box, so we fetch the key, encrypt, then upload the base64 ciphertext.
export const putRepoSecret = async (owner: string, repo: string, name: string, value: string): Promise<void> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const keyRes = await ghInstallationRequest(token, `/repos/${owner}/${repo}/actions/secrets/public-key`);
    if (!keyRes.ok) throw new Error(`Failed to fetch Actions public key for ${owner}/${repo}: ${keyRes.status} ${await keyRes.text()}`);
    const { key, key_id } = (await keyRes.json()) as { key: string; key_id: string };

    await sodium.ready;
    const messageBytes = sodium.from_string(value);
    const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

    const putRes = await ghInstallationRequest(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
    });
    if (!putRes.ok) throw new Error(`Failed to set secret ${name} for ${owner}/${repo}: ${putRes.status} ${await putRes.text()}`);
};

// DELETE a repository Actions secret. Best-effort: a 404 (already gone) is treated as success.
export const deleteRepoSecret = async (owner: string, repo: string, name: string): Promise<void> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Failed to delete secret ${name} for ${owner}/${repo}: ${res.status} ${await res.text()}`);
};

// Fetch the blob SHA of a file on a branch, or undefined if it does not exist. Needed to update an
// existing workflow file (GitHub requires the prior SHA on update).
export const getRepoFileSha = async (owner: string, repo: string, filePath: string, ref: string): Promise<string | undefined> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/contents/${encodeContentsPath(filePath)}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Failed to read ${filePath} in ${owner}/${repo}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { sha: string };
    return data.sha;
};

// Create or update a file on a branch. Returns the resulting commit SHA.
export const putRepoFile = async (
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    message: string,
    branch: string,
    sha?: string
): Promise<string> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/contents/${encodeContentsPath(filePath)}`, {
        method: 'PUT',
        body: JSON.stringify({
            message,
            content: Buffer.from(content, 'utf-8').toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
        }),
    });
    if (!res.ok) throw new Error(`Failed to commit ${filePath} to ${owner}/${repo}@${branch}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { commit: { sha: string } };
    return data.commit.sha;
};

// Delete a file on a branch. Best-effort: a 404 (already gone) is treated as success.
export const deleteRepoFile = async (owner: string, repo: string, filePath: string, message: string, branch: string): Promise<void> => {
    const sha = await getRepoFileSha(owner, repo, filePath, branch);
    if (!sha) return;
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/contents/${encodeContentsPath(filePath)}`, {
        method: 'DELETE',
        body: JSON.stringify({ message, sha, branch }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Failed to delete ${filePath} from ${owner}/${repo}@${branch}: ${res.status} ${await res.text()}`);
};

// The repository's default branch (used as the base when opening a PR).
export const getDefaultBranch = async (owner: string, repo: string): Promise<string> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}`);
    if (!res.ok) throw new Error(`Failed to read repo ${owner}/${repo}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { default_branch: string };
    return data.default_branch;
};

// The tip commit SHA of a branch.
export const getBranchSha = async (owner: string, repo: string, branch: string): Promise<string> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
    if (!res.ok) throw new Error(`Failed to read branch ${branch} in ${owner}/${repo}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { object: { sha: string } };
    return data.object.sha;
};

// Create a new branch pointing at the given commit SHA.
export const createBranch = async (owner: string, repo: string, branch: string, fromSha: string): Promise<void> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    });
    if (!res.ok) throw new Error(`Failed to create branch ${branch} in ${owner}/${repo}: ${res.status} ${await res.text()}`);
};

// Delete a branch (used to clean up an NSM PR branch on CD removal). Best-effort.
export const deleteBranch = async (owner: string, repo: string, branch: string): Promise<void> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404 && res.status !== 422) {
        throw new Error(`Failed to delete branch ${branch} in ${owner}/${repo}: ${res.status} ${await res.text()}`);
    }
};

// Open a pull request. Returns its html_url.
export const createPullRequest = async (owner: string, repo: string, head: string, base: string, title: string, body: string): Promise<string> => {
    const token = (await mintInstallationToken(owner, repo)).token;
    const res = await ghInstallationRequest(token, `/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ head, base, title, body }),
    });
    if (!res.ok) throw new Error(`Failed to open pull request in ${owner}/${repo}: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { html_url: string };
    return data.html_url;
};

// The contents API expects each path segment encoded but slashes preserved.
const encodeContentsPath = (filePath: string): string => filePath.split('/').map(encodeURIComponent).join('/');

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
