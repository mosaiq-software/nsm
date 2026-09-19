// Rich, typed definition of the node environment variables that are safe to edit at runtime from the
// node configuration editor. This is the single source of truth shared by the backend (validation +
// masking) and the frontend (field rendering). It intentionally excludes anything that requires a
// full reinstall/re-provision to change: cluster identity (NODE_ID, NSM_ROLE, LEADER_ADDRESS,
// CLUSTER_SECRET, ...), install-layout paths, public URLs, and every VITE_* build-baked var.

export type EnvVarType = 'string' | 'number' | 'boolean' | 'url' | 'enum';

export interface EnvVarSpec {
    // The environment variable name as it appears in nsm.env.
    key: string;
    // Human-readable field label.
    label: string;
    // What the variable does / why it exists.
    description: string;
    // Grouping shown in the editor.
    category: string;
    type: EnvVarType;
    // When false, an empty value is allowed and clears the key from the file (restoring the default).
    required: boolean;
    // Secret values are never sent to the browser: the API returns only their length, and the field
    // renders as a non-revealable password box.
    secret?: boolean;
    // Allowed values for `enum` fields.
    options?: string[];
    placeholder?: string;
    // The daemon's effective default when the key is absent. Used only to render the correct initial
    // state (e.g. a boolean toggle) in the editor; it is never written on its own.
    defaultValue?: string;
    // Purely informational: this var only takes effect on the leader node.
    leaderOnly?: boolean;
}

// A single variable's current value as returned to the editor. Secret values are masked to their
// length so the UI can render the right number of dots without ever receiving the secret.
export type NodeConfigValue = { isSecret: true; length: number } | { isSecret?: false; value: string | null };

export type NodeConfigValues = Record<string, NodeConfigValue>;

// The changes the editor sends back: only keys the admin actually changed. Cleared optional keys go
// in `unset` (removed from the file); everything else is in `set`. Unchanged secrets are omitted.
export interface NodeConfigUpdate {
    set: Record<string, string>;
    unset: string[];
}

export const EDITABLE_ENV_SPECS: EnvVarSpec[] = [
    // === Cloudflare (leader-only DNS + domains) ===
    {
        key: 'CLOUDFLARE_API_TOKEN',
        label: 'Cloudflare API token',
        description: 'Token used for all Cloudflare DNS and domain operations. Empty disables the whole Cloudflare feature.',
        category: 'Cloudflare',
        type: 'string',
        required: false,
        secret: true,
        leaderOnly: true,
    },
    {
        key: 'CLOUDFLARE_ACCOUNT_ID',
        label: 'Cloudflare account ID',
        description: 'Account ID required for registrar (domain search/purchase) operations.',
        category: 'Cloudflare',
        type: 'string',
        required: false,
        leaderOnly: true,
    },
    {
        key: 'PUBLIC_IP_POLL_MINUTES',
        label: 'Public IP poll interval (minutes)',
        description: 'How often the leader checks its public (WAN) IP to repush dynamic-IP DNS records.',
        category: 'Cloudflare',
        type: 'number',
        required: false,
        placeholder: '10',
        leaderOnly: true,
    },

    // === Deploys ===
    {
        key: 'ZERO_DOWNTIME_DEPLOYS',
        label: 'Zero-downtime deploys',
        description: 'When on, new generations are health-gated and nginx is flipped only once ready. When off, this node uses in-place recreation.',
        category: 'Deploys',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
    },
    {
        key: 'DEPLOY_DRAIN_MS',
        label: 'Deploy drain (ms)',
        description: 'How long the old generation keeps serving after nginx cutover before it is torn down.',
        category: 'Deploys',
        type: 'number',
        required: false,
        placeholder: '10000',
    },
    {
        key: 'READINESS_TIMEOUT_MS',
        label: 'Readiness timeout (ms)',
        description: 'Upper bound on the readiness gate for a new generation.',
        category: 'Deploys',
        type: 'number',
        required: false,
        placeholder: '120000',
    },
    {
        key: 'READINESS_INTERVAL_MS',
        label: 'Readiness poll interval (ms)',
        description: 'Poll interval used while waiting for the readiness gate to pass.',
        category: 'Deploys',
        type: 'number',
        required: false,
        placeholder: '2000',
    },

    // === Observability ===
    {
        key: 'LOKI_URL',
        label: 'Loki URL',
        description: 'Leader-side Loki query endpoint used by the logs UI.',
        category: 'Observability',
        type: 'url',
        required: false,
        placeholder: 'http://127.0.0.1:3100',
    },
    {
        key: 'PROMETHEUS_URL',
        label: 'Prometheus URL',
        description: 'Leader-side Prometheus query endpoint used by the metrics UI.',
        category: 'Observability',
        type: 'url',
        required: false,
        placeholder: 'http://127.0.0.1:9090',
    },
    {
        key: 'GRAFANA_URL',
        label: 'Grafana URL',
        description: 'Grafana base URL linked from the observability views.',
        category: 'Observability',
        type: 'url',
        required: false,
        placeholder: 'http://127.0.0.1:3000',
    },
    {
        key: 'OBS_LOKI_PUSH_URL',
        label: 'Loki push URL',
        description: 'Where this node ships logs. Leave empty to let the daemon derive a container-reachable URL automatically.',
        category: 'Observability',
        type: 'url',
        required: false,
    },

    // === GitHub App ===
    {
        key: 'GITHUB_APP_ID',
        label: 'GitHub App ID',
        description: 'App id used to mint installation tokens for cloning private repos and discovering teams.',
        category: 'GitHub App',
        type: 'string',
        required: false,
        leaderOnly: true,
    },
    {
        key: 'GITHUB_APP_INSTALLATION_ID',
        label: 'GitHub App installation ID',
        description: 'Optional; auto-resolved per repo when empty.',
        category: 'GitHub App',
        type: 'string',
        required: false,
        leaderOnly: true,
    },
    {
        key: 'GITHUB_APP_PRIVATE_KEY_PATH',
        label: 'GitHub App private key path',
        description: 'Filesystem path to the App private key (.pem). The key file itself is not managed here.',
        category: 'GitHub App',
        type: 'string',
        required: false,
        placeholder: '/etc/nsm/github-app.pem',
        leaderOnly: true,
    },

    // === GitHub OAuth ===
    {
        key: 'GITHUB_OAUTH_CLIENT_SECRET',
        label: 'GitHub OAuth client secret',
        description: 'Server-side OAuth client secret used during the sign-in handshake.',
        category: 'GitHub OAuth',
        type: 'string',
        required: false,
        secret: true,
        leaderOnly: true,
    },

    // === Web Push ===
    {
        key: 'NSM_VAPID_PUBLIC_KEY',
        label: 'VAPID public key',
        description: 'Pinned Web Push public key. Leave empty to let the leader auto-generate and persist a pair.',
        category: 'Web Push',
        type: 'string',
        required: false,
        leaderOnly: true,
    },
    {
        key: 'NSM_VAPID_PRIVATE_KEY',
        label: 'VAPID private key',
        description: 'Pinned Web Push private key. Only the leader signs and sends push messages.',
        category: 'Web Push',
        type: 'string',
        required: false,
        secret: true,
        leaderOnly: true,
    },
    {
        key: 'NSM_VAPID_SUBJECT',
        label: 'VAPID subject',
        description: 'Contact URI (mailto: or https:) included in push requests, per the VAPID spec.',
        category: 'Web Push',
        type: 'string',
        required: false,
        placeholder: 'mailto:admin@nsm.local',
        leaderOnly: true,
    },

    // === Certificates ===
    {
        key: 'CERTBOT_DNS_ARGS',
        label: 'Certbot DNS args',
        description: 'certbot DNS plugin command prefix, e.g. "--dns-cloudflare --dns-cloudflare-credentials /etc/nsm/cf.ini".',
        category: 'Certificates',
        type: 'string',
        required: false,
    },

    // === Logging ===
    {
        key: 'DATABASE_LOGGING',
        label: 'Database query logging',
        description: 'When on, Sequelize logs every SQL query (verbose; for debugging only).',
        category: 'Logging',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
    },
];

export const EDITABLE_ENV_KEYS = new Set(EDITABLE_ENV_SPECS.map((s) => s.key));

export const getEnvSpec = (key: string): EnvVarSpec | undefined => EDITABLE_ENV_SPECS.find((s) => s.key === key);
