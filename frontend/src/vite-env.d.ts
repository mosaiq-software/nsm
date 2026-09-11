/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
    readonly VITE_GITHUB_OAUTH_CLIENT_ID?: string;
    readonly VITE_GITHUB_OAUTH_CALLBACK_URL?: string;
    readonly VITE_GITHUB_OAUTH_DEFAULT_USER?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
