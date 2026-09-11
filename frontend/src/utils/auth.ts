import queryString from 'query-string';

export const getGithubLoginUrl = () => {
    const client_id = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID;
    const redirect_uri = import.meta.env.VITE_GITHUB_OAUTH_CALLBACK_URL;
    const scope = ['read:user', 'user:email', 'read:org'].join(' ');
    const allow_signup = true;

    if (!client_id || !redirect_uri) {
        throw new Error('Missing required environment variables for GitHub OAuth (VITE_GITHUB_OAUTH_CLIENT_ID, VITE_GITHUB_OAUTH_CALLBACK_URL)');
    }

    const params = queryString.stringify({ client_id, redirect_uri, scope, allow_signup });
    const baseUrl = 'https://github.com/login/oauth/authorize?';
    return `${baseUrl}${params}`;
};
