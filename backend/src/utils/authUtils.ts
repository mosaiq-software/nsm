import queryString from 'query-string';
import { areaLog } from '@/utils/log';

const authLog = areaLog('auth');

export interface GithubUserProfile {
    id: string;
    login: string;
    avatar_url: string;
    name: string;
}

export const getGithubAuthTokenFromTempCode = async (code: string) => {
    if (!code) {
        throw new Error('No code provided');
    }
    try {
        const queryParam = queryString.stringify({
            client_id: process.env.VITE_GITHUB_OAUTH_CLIENT_ID,
            client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
            redirect_uri: process.env.VITE_GITHUB_OAUTH_CALLBACK_URL,
            code,
        });
        const res = await fetch(`https://github.com/login/oauth/access_token?${queryParam}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            throw new Error(`GitHub token exchange failed with status ${res.status}`);
        }
        const parsedData = await res.json();
        if (parsedData.error) throw new Error(parsedData.error_description as string);
        authLog.info({ action: 'oauth_token_exchanged' }, 'exchanged GitHub OAuth code for token');
        return parsedData.access_token as string;
    } catch (error: any) {
        authLog.warn({ action: 'oauth_exchange_failed', err: error?.message }, 'GitHub OAuth token exchange failed');
        return null;
    }
};

export async function getPrivateGitHubUserData(access_token: string): Promise<GithubUserProfile | null> {
    try {
        const res = await fetch('https://api.github.com/user', {
            method: 'GET',
            headers: {
                Authorization: `token ${access_token}`,
            },
        });
        if (!res.ok) {
            authLog.warn({ action: 'github_user_fetch_failed', status: res.status }, `GitHub user fetch failed with status ${res.status}`);
            return null;
        }
        const profile = (await res.json()) as GithubUserProfile;
        authLog.info({ action: 'github_user_fetched', login: profile.login }, `fetched GitHub user ${profile.login}`);
        return profile;
    } catch (error: any) {
        authLog.error({ action: 'github_user_fetch_error', err: error?.message }, 'error fetching GitHub user data');
        return null;
    }
}

export interface GithubOrgRes {
    avatar_url: string;
    description: string;
    events_url: string;
    hooks_url: string;
    id: number;
    issues_url: string;
    login: string;
    members_url: string;
    node_id: string;
    public_members_url: string;
    repos_url: string;
    url: string;
}

export async function getOrgsForUser(access_token: string) {
    try {
        const res = await fetch('https://api.github.com/user/orgs', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${access_token}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        const txt = await res.text();
        if (!res.ok) {
            throw new Error(`GitHub org fetch failed with status ${res.status}: ${txt}`);
        }
        try {
            const orgs = JSON.parse(txt) as GithubOrgRes[];
            authLog.info({ action: 'github_orgs_fetched', orgCount: orgs.length }, `fetched ${orgs.length} GitHub org(s)`);
            return orgs;
        } catch (e) {
            throw new Error(`GitHub org fetch returned invalid JSON: ${txt}`);
        }
    } catch (error: any) {
        authLog.error({ action: 'github_orgs_fetch_error', err: error?.message }, 'error fetching GitHub organizations');
        return null;
    }
}

export const revokeGithubAuth = async (access_token: string) => {
    try {
        const credentials = `${process.env.VITE_GITHUB_OAUTH_CLIENT_ID}:${process.env.GITHUB_OAUTH_CLIENT_SECRET}`;
        const encodedCredentials = btoa(credentials);
        const response = await fetch(`https://api.github.com/applications/${process.env.VITE_GITHUB_OAUTH_CLIENT_ID}/grant`, {
            method: 'DELETE',
            headers: {
                Authorization: `Basic ${encodedCredentials}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
                access_token: access_token,
            }),
        });
        if (!response.ok) {
            throw new Error('Unable to revoke access token. Status: ' + response.status);
        }
        authLog.info({ action: 'github_token_revoked', status: response.status }, 'revoked GitHub token');
    } catch (error: any) {
        authLog.error({ action: 'github_token_revoke_error', err: error?.message }, 'error revoking GitHub token');
    }
};
