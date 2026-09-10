import queryString from 'query-string';

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
            client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
            client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
            redirect_uri: process.env.GITHUB_OAUTH_CALLBACK_URL,
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
        return parsedData.access_token as string;
    } catch (error) {
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
        return res.json();
    } catch (error) {
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
            return JSON.parse(txt) as GithubOrgRes[];
        } catch (e) {
            throw new Error(`GitHub org fetch returned invalid JSON: ${txt}`);
        }
    } catch (error) {
        return null;
    }
}

export const revokeGithubAuth = async (access_token: string) => {
    try {
        const credentials = `${process.env.GITHUB_OAUTH_CLIENT_ID}:${process.env.GITHUB_OAUTH_CLIENT_SECRET}`;
        const encodedCredentials = btoa(credentials);
        const response = await fetch(`https://api.github.com/applications/${process.env.GITHUB_OAUTH_CLIENT_ID}/grant`, {
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
    } catch (error: any) {
        console.error('Error revoking GitHub token:', error);
    }
};
