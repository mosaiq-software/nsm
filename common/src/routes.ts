import { Admin, Capability, CdSetupRequest, ClusterNode, ClusterStatus, DeploymentLogUpdate, DnsRecord, DnsZone, DomainAllocationResult, DomainBillingSummary, DomainCheckResult, DomainRequest, DomainSearchResult, GithubOwner, LogMessage, LogQueryRequest, LogQueryResult, LogFacetsRequest, LogFacetsResult, MeResponse, NodeStorageSpec, ObservabilityLogsResult, ObservabilityMetricsResult, Project, ProjectInstance, ProjectResourceQuota, ProjectResourceUsage, PushSubscriptionJSON, Secret, Team, TeamDetail, User } from './types';
import { NodeConfigUpdate, NodeConfigValues } from './envSchema';

// ===== ROUTES =====
export enum API_ROUTES {
    // GET
    GET_DEPLOY = '/deploy/:projectId/:key',
    GET_DEPLOY_WEB = '/deployweb/:projectId/:key',
    GET_PROJECT = '/project/:projectId',
    GET_PROJECTS = '/projects',
    GET_PROJECT_INSTANCE = '/project-instance/:projectInstanceId',
    GET_WORKER_NODES = '/cluster/nodes',
    GET_WORKER_STATUSES = '/cluster/nodes/status',
    GET_JOIN_INFO = '/cluster/join-info',
    GET_CONTROL_PLANE_STATUS = '/cluster/status',
    GET_ME = '/me',
    GET_TEAMS = '/teams',
    GET_TEAM = '/team/:ownerId',
    GET_ADMINS = '/admins',
    GET_OBSERVABILITY_LOGS = '/observability/logs',
    GET_OBSERVABILITY_METRICS = '/observability/metrics',
    GET_NODE_METRICS = '/observability/node-metrics',
    GET_NODE_STORAGE = '/observability/node-storage',
    GET_NODE_STORAGE_SERIES = '/observability/node-storage/series',
    GET_NSM_LOGS = '/observability/nsm-logs',
    GET_GITHUB_OWNERS = '/github/owners',
    GET_GITHUB_REPOS = '/github/repos',
    GET_GITHUB_BRANCHES = '/github/branches',
    GET_VAPID_PUBLIC_KEY = '/push/vapid-public-key',
    GET_PROJECT_NOTIFICATION = '/push/preference/:projectId',
    GET_PROJECT_RESOURCE_USAGE = '/project/:projectId/resource-usage',
    GET_DOMAINS = '/domains',
    GET_DOMAIN_REQUESTS = '/domains/requests',
    GET_DOMAIN_BILLING = '/domains/billing',
    GET_PUBLIC_IP = '/domains/public-ip',
    GET_DNS_RECORDS = '/domains/:zoneId/records',
    GET_PROJECT_DOMAINS = '/project/:projectId/domains',
    GET_NODE_CONFIG = '/nodes/:nodeId/config',

    //POST
    POST_CREATE_PROJECT = '/project/create',
    POST_UPDATE_PROJECT = '/project/:projectId/update',
    POST_DELETE_PROJECT = '/project/:projectId/delete',
    POST_RESET_DEPLOYMENT_KEY = '/project/:projectId/reset-key',
    POST_UPDATE_ENV_VAR = '/project/:projectId/updateEnvVar',
    POST_SYNC_TO_REPO = '/project/:projectId/sync-to-repo',
    POST_TEARDOWN_PROJECT = '/project/:projectId/teardown',
    POST_CANCEL_DEPLOY = '/project/:projectId/cancel-deploy',
    POST_SET_PROJECT_ASSIGNMENT = '/project/:projectId/assign',
    POST_CICD_SETUP = '/project/:projectId/cicd/setup',
    POST_CICD_REMOVE = '/project/:projectId/cicd/remove',
    POST_DEPLOYMENT_LOG_UPDATE = '/deploy/update',
    POST_GITHUB_LOGIN = '/login/github/:token',
    POST_GITHUB_LOGOUT = '/logout/github/:token',
    POST_SET_TEAM_DEFAULTS = '/team/:ownerId/defaults',
    POST_SET_TEAM_OVERRIDE = '/team/:ownerId/override',
    POST_DELETE_TEAM_OVERRIDE = '/team/:ownerId/override/delete',
    POST_ADD_ADMIN = '/admins/add',
    POST_REMOVE_ADMIN = '/admins/remove',
    POST_LOGGER = '/logger/:logKey',
    POST_PUSH_SUBSCRIBE = '/push/subscribe',
    POST_PUSH_UNSUBSCRIBE = '/push/unsubscribe',
    POST_SET_PROJECT_NOTIFICATION = '/push/preference/:projectId/set',
    POST_REGENERATE_VAPID = '/push/vapid/regenerate',
    POST_LOG_QUERY = '/observability/query',
    POST_LOG_FACETS = '/observability/facets',
    POST_NODE_STORAGE_SNAPSHOT = '/observability/node-storage/snapshot',
    POST_SET_PROJECT_QUOTA = '/project/:projectId/quota',
    POST_DOMAIN_SEARCH = '/domains/search',
    POST_DOMAIN_CHECK = '/domains/check',
    POST_DOMAIN_REQUEST = '/domains/request',
    POST_DOMAIN_REQUEST_DECIDE = '/domains/requests/:requestId/decide',
    POST_DOMAIN_DELETE = '/domains/:zoneId/delete',
    POST_DOMAIN_ALLOCATIONS = '/domains/:zoneId/allocations',
    POST_DOMAIN_ASSIGN = '/domains/:zoneId/assign',
    POST_DNS_RECORD_CREATE = '/domains/:zoneId/records/create',
    POST_DNS_RECORD_UPDATE = '/domains/:zoneId/records/:recordId/update',
    POST_DNS_RECORD_DELETE = '/domains/:zoneId/records/:recordId/delete',
    POST_PUBLIC_IP_REFRESH = '/domains/public-ip/refresh',
    POST_NODE_CONFIG = '/nodes/:nodeId/config/apply',
}
export interface API_PARAMS {
    //GET
    [API_ROUTES.GET_DEPLOY]: { projectId: string; key: string };
    [API_ROUTES.GET_DEPLOY_WEB]: { projectId: string; key: string };
    [API_ROUTES.GET_PROJECT]: { projectId: string };
    [API_ROUTES.GET_PROJECTS]: {};
    [API_ROUTES.GET_PROJECT_INSTANCE]: { projectInstanceId: string };
    [API_ROUTES.GET_WORKER_NODES]: {};
    [API_ROUTES.GET_WORKER_STATUSES]: {};
    [API_ROUTES.GET_JOIN_INFO]: {};
    [API_ROUTES.GET_CONTROL_PLANE_STATUS]: {};
    [API_ROUTES.GET_ME]: {};
    [API_ROUTES.GET_TEAMS]: {};
    [API_ROUTES.GET_TEAM]: { ownerId: string };
    [API_ROUTES.GET_ADMINS]: {};
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: {};
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: {};
    [API_ROUTES.GET_NODE_METRICS]: {};
    [API_ROUTES.GET_NODE_STORAGE]: {};
    [API_ROUTES.GET_NODE_STORAGE_SERIES]: {};
    [API_ROUTES.GET_NSM_LOGS]: {};
    [API_ROUTES.GET_GITHUB_OWNERS]: {};
    [API_ROUTES.GET_GITHUB_REPOS]: {};
    [API_ROUTES.GET_GITHUB_BRANCHES]: {};
    [API_ROUTES.GET_VAPID_PUBLIC_KEY]: {};
    [API_ROUTES.GET_PROJECT_NOTIFICATION]: { projectId: string };
    [API_ROUTES.GET_PROJECT_RESOURCE_USAGE]: { projectId: string };
    [API_ROUTES.GET_DOMAINS]: {};
    [API_ROUTES.GET_DOMAIN_REQUESTS]: {};
    [API_ROUTES.GET_DOMAIN_BILLING]: {};
    [API_ROUTES.GET_PUBLIC_IP]: {};
    [API_ROUTES.GET_DNS_RECORDS]: { zoneId: string };
    [API_ROUTES.GET_PROJECT_DOMAINS]: { projectId: string };
    [API_ROUTES.GET_NODE_CONFIG]: { nodeId: string };

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: {};
    [API_ROUTES.POST_UPDATE_PROJECT]: { projectId: string };
    [API_ROUTES.POST_DELETE_PROJECT]: { projectId: string };
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: { projectId: string };
    [API_ROUTES.POST_UPDATE_ENV_VAR]: { projectId: string };
    [API_ROUTES.POST_SYNC_TO_REPO]: { projectId: string };
    [API_ROUTES.POST_TEARDOWN_PROJECT]: { projectId: string };
    [API_ROUTES.POST_CANCEL_DEPLOY]: { projectId: string };
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: { projectId: string };
    [API_ROUTES.POST_CICD_SETUP]: { projectId: string };
    [API_ROUTES.POST_CICD_REMOVE]: { projectId: string };
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: {};
    [API_ROUTES.POST_GITHUB_LOGIN]: { token: string };
    [API_ROUTES.POST_GITHUB_LOGOUT]: { token: string };
    [API_ROUTES.POST_SET_TEAM_DEFAULTS]: { ownerId: string };
    [API_ROUTES.POST_SET_TEAM_OVERRIDE]: { ownerId: string };
    [API_ROUTES.POST_DELETE_TEAM_OVERRIDE]: { ownerId: string };
    [API_ROUTES.POST_ADD_ADMIN]: {};
    [API_ROUTES.POST_REMOVE_ADMIN]: {};
    [API_ROUTES.POST_LOGGER]: { logKey: string };
    [API_ROUTES.POST_PUSH_SUBSCRIBE]: {};
    [API_ROUTES.POST_PUSH_UNSUBSCRIBE]: {};
    [API_ROUTES.POST_SET_PROJECT_NOTIFICATION]: { projectId: string };
    [API_ROUTES.POST_REGENERATE_VAPID]: {};
    [API_ROUTES.POST_LOG_QUERY]: {};
    [API_ROUTES.POST_LOG_FACETS]: {};
    [API_ROUTES.POST_NODE_STORAGE_SNAPSHOT]: {};
    [API_ROUTES.POST_SET_PROJECT_QUOTA]: { projectId: string };
    [API_ROUTES.POST_DOMAIN_SEARCH]: {};
    [API_ROUTES.POST_DOMAIN_CHECK]: {};
    [API_ROUTES.POST_DOMAIN_REQUEST]: {};
    [API_ROUTES.POST_DOMAIN_REQUEST_DECIDE]: { requestId: string };
    [API_ROUTES.POST_DOMAIN_DELETE]: { zoneId: string };
    [API_ROUTES.POST_DOMAIN_ALLOCATIONS]: { zoneId: string };
    [API_ROUTES.POST_DOMAIN_ASSIGN]: { zoneId: string };
    [API_ROUTES.POST_DNS_RECORD_CREATE]: { zoneId: string };
    [API_ROUTES.POST_DNS_RECORD_UPDATE]: { zoneId: string; recordId: string };
    [API_ROUTES.POST_DNS_RECORD_DELETE]: { zoneId: string; recordId: string };
    [API_ROUTES.POST_PUBLIC_IP_REFRESH]: {};
    [API_ROUTES.POST_NODE_CONFIG]: { nodeId: string };
}
export interface API_BODY {
    // Only POST
    // GET
    [API_ROUTES.GET_DEPLOY]: undefined;
    [API_ROUTES.GET_DEPLOY_WEB]: undefined;
    [API_ROUTES.GET_PROJECT]: undefined;
    [API_ROUTES.GET_PROJECTS]: undefined;
    [API_ROUTES.GET_PROJECT_INSTANCE]: undefined;
    [API_ROUTES.GET_WORKER_NODES]: undefined;
    [API_ROUTES.GET_WORKER_STATUSES]: undefined;
    [API_ROUTES.GET_JOIN_INFO]: undefined;
    [API_ROUTES.GET_CONTROL_PLANE_STATUS]: undefined;
    [API_ROUTES.GET_ME]: undefined;
    [API_ROUTES.GET_TEAMS]: undefined;
    [API_ROUTES.GET_TEAM]: undefined;
    [API_ROUTES.GET_ADMINS]: undefined;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: undefined;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: undefined;
    [API_ROUTES.GET_NODE_METRICS]: undefined;
    [API_ROUTES.GET_NODE_STORAGE]: undefined;
    [API_ROUTES.GET_NODE_STORAGE_SERIES]: undefined;
    [API_ROUTES.GET_NSM_LOGS]: undefined;
    [API_ROUTES.GET_GITHUB_OWNERS]: undefined;
    [API_ROUTES.GET_GITHUB_REPOS]: undefined;
    [API_ROUTES.GET_GITHUB_BRANCHES]: undefined;
    [API_ROUTES.GET_VAPID_PUBLIC_KEY]: undefined;
    [API_ROUTES.GET_PROJECT_NOTIFICATION]: undefined;
    [API_ROUTES.GET_PROJECT_RESOURCE_USAGE]: undefined;
    [API_ROUTES.GET_DOMAINS]: undefined;
    [API_ROUTES.GET_DOMAIN_REQUESTS]: undefined;
    [API_ROUTES.GET_DOMAIN_BILLING]: undefined;
    [API_ROUTES.GET_PUBLIC_IP]: undefined;
    [API_ROUTES.GET_DNS_RECORDS]: undefined;
    [API_ROUTES.GET_PROJECT_DOMAINS]: undefined;
    [API_ROUTES.GET_NODE_CONFIG]: undefined;

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: Project;
    [API_ROUTES.POST_UPDATE_PROJECT]: Partial<Project>;
    [API_ROUTES.POST_DELETE_PROJECT]: {};
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: {};
    [API_ROUTES.POST_UPDATE_ENV_VAR]: Secret;
    [API_ROUTES.POST_SYNC_TO_REPO]: {};
    [API_ROUTES.POST_TEARDOWN_PROJECT]: {};
    [API_ROUTES.POST_CANCEL_DEPLOY]: {};
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: { nodeId: string };
    [API_ROUTES.POST_CICD_SETUP]: CdSetupRequest;
    [API_ROUTES.POST_CICD_REMOVE]: {};
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: DeploymentLogUpdate;
    [API_ROUTES.POST_GITHUB_LOGIN]: {};
    [API_ROUTES.POST_GITHUB_LOGOUT]: {};
    [API_ROUTES.POST_SET_TEAM_DEFAULTS]: { capabilities: Capability[] };
    [API_ROUTES.POST_SET_TEAM_OVERRIDE]: { memberId: string; memberLogin: string; capabilities: Capability[] };
    [API_ROUTES.POST_DELETE_TEAM_OVERRIDE]: { memberId: string };
    [API_ROUTES.POST_ADD_ADMIN]: { login: string };
    [API_ROUTES.POST_REMOVE_ADMIN]: { id: string };
    [API_ROUTES.POST_LOGGER]: LogMessage;
    [API_ROUTES.POST_PUSH_SUBSCRIBE]: PushSubscriptionJSON;
    [API_ROUTES.POST_PUSH_UNSUBSCRIBE]: { endpoint: string };
    [API_ROUTES.POST_SET_PROJECT_NOTIFICATION]: { enabled: boolean };
    [API_ROUTES.POST_REGENERATE_VAPID]: {};
    [API_ROUTES.POST_LOG_QUERY]: LogQueryRequest;
    [API_ROUTES.POST_LOG_FACETS]: LogFacetsRequest;
    [API_ROUTES.POST_NODE_STORAGE_SNAPSHOT]: { nodeId: string };
    [API_ROUTES.POST_SET_PROJECT_QUOTA]: ProjectResourceQuota;
    [API_ROUTES.POST_DOMAIN_SEARCH]: { query: string };
    [API_ROUTES.POST_DOMAIN_CHECK]: { domains: string[] };
    [API_ROUTES.POST_DOMAIN_REQUEST]: { domainName: string; ownerId: string; priceCurrency?: string; priceRegistration?: string; priceRenewal?: string };
    [API_ROUTES.POST_DOMAIN_REQUEST_DECIDE]: { approve: boolean; reason?: string };
    [API_ROUTES.POST_DOMAIN_DELETE]: { confirmName: string };
    [API_ROUTES.POST_DOMAIN_ALLOCATIONS]: { ownerIds: string[] };
    [API_ROUTES.POST_DOMAIN_ASSIGN]: { projectId: string | null };
    [API_ROUTES.POST_DNS_RECORD_CREATE]: Partial<DnsRecord>;
    [API_ROUTES.POST_DNS_RECORD_UPDATE]: Partial<DnsRecord>;
    [API_ROUTES.POST_DNS_RECORD_DELETE]: {};
    [API_ROUTES.POST_PUBLIC_IP_REFRESH]: {};
    [API_ROUTES.POST_NODE_CONFIG]: NodeConfigUpdate;
}
export interface API_RETURN {
    //GET
    [API_ROUTES.GET_DEPLOY]: undefined;
    [API_ROUTES.GET_DEPLOY_WEB]: string | undefined;
    [API_ROUTES.GET_PROJECT]: Project | undefined;
    [API_ROUTES.GET_PROJECTS]: Project[];
    [API_ROUTES.GET_PROJECT_INSTANCE]: ProjectInstance | undefined;
    [API_ROUTES.GET_WORKER_NODES]: ClusterNode[] | undefined;
    [API_ROUTES.GET_WORKER_STATUSES]: undefined; //TODO
    [API_ROUTES.GET_JOIN_INFO]: { command: string; deployPublicKey: string | null };
    [API_ROUTES.GET_CONTROL_PLANE_STATUS]: ClusterStatus | undefined;
    [API_ROUTES.GET_ME]: MeResponse | undefined;
    [API_ROUTES.GET_TEAMS]: Team[];
    [API_ROUTES.GET_TEAM]: TeamDetail | undefined;
    [API_ROUTES.GET_ADMINS]: { admins: Admin[]; superAdminLogin: string | null } | undefined;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: ObservabilityLogsResult | undefined;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: ObservabilityMetricsResult | undefined;
    [API_ROUTES.GET_NODE_METRICS]: ObservabilityMetricsResult | undefined;
    [API_ROUTES.GET_NODE_STORAGE]: NodeStorageSpec | undefined;
    [API_ROUTES.GET_NODE_STORAGE_SERIES]: ObservabilityMetricsResult | undefined;
    [API_ROUTES.GET_NSM_LOGS]: ObservabilityLogsResult | undefined;
    [API_ROUTES.GET_GITHUB_OWNERS]: GithubOwner[];
    [API_ROUTES.GET_GITHUB_REPOS]: string[];
    [API_ROUTES.GET_GITHUB_BRANCHES]: string[];
    [API_ROUTES.GET_VAPID_PUBLIC_KEY]: string;
    [API_ROUTES.GET_PROJECT_NOTIFICATION]: { enabled: boolean };
    [API_ROUTES.GET_PROJECT_RESOURCE_USAGE]: ProjectResourceUsage | undefined;
    [API_ROUTES.GET_DOMAINS]: DnsZone[];
    [API_ROUTES.GET_DOMAIN_REQUESTS]: DomainRequest[];
    [API_ROUTES.GET_DOMAIN_BILLING]: DomainBillingSummary | undefined;
    [API_ROUTES.GET_PUBLIC_IP]: { ip: string | null };
    [API_ROUTES.GET_DNS_RECORDS]: DnsRecord[];
    [API_ROUTES.GET_PROJECT_DOMAINS]: string[];
    [API_ROUTES.GET_NODE_CONFIG]: NodeConfigValues | undefined;

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: Project;
    [API_ROUTES.POST_UPDATE_PROJECT]: undefined;
    [API_ROUTES.POST_DELETE_PROJECT]: undefined;
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: string | undefined;
    [API_ROUTES.POST_UPDATE_ENV_VAR]: undefined;
    [API_ROUTES.POST_SYNC_TO_REPO]: Project | undefined;
    [API_ROUTES.POST_TEARDOWN_PROJECT]: undefined;
    [API_ROUTES.POST_CANCEL_DEPLOY]: undefined;
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: undefined;
    [API_ROUTES.POST_CICD_SETUP]: Project | undefined;
    [API_ROUTES.POST_CICD_REMOVE]: Project | undefined;
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: undefined;
    [API_ROUTES.POST_GITHUB_LOGIN]: User | undefined;
    [API_ROUTES.POST_GITHUB_LOGOUT]: undefined;
    [API_ROUTES.POST_SET_TEAM_DEFAULTS]: undefined;
    [API_ROUTES.POST_SET_TEAM_OVERRIDE]: undefined;
    [API_ROUTES.POST_DELETE_TEAM_OVERRIDE]: undefined;
    [API_ROUTES.POST_ADD_ADMIN]: Admin | undefined;
    [API_ROUTES.POST_REMOVE_ADMIN]: undefined;
    [API_ROUTES.POST_LOGGER]: undefined;
    [API_ROUTES.POST_PUSH_SUBSCRIBE]: undefined;
    [API_ROUTES.POST_PUSH_UNSUBSCRIBE]: undefined;
    [API_ROUTES.POST_SET_PROJECT_NOTIFICATION]: undefined;
    [API_ROUTES.POST_REGENERATE_VAPID]: { ok: boolean; reason?: string };
    [API_ROUTES.POST_LOG_QUERY]: LogQueryResult | undefined;
    [API_ROUTES.POST_LOG_FACETS]: LogFacetsResult | undefined;
    [API_ROUTES.POST_NODE_STORAGE_SNAPSHOT]: NodeStorageSpec | undefined;
    [API_ROUTES.POST_SET_PROJECT_QUOTA]: undefined;
    [API_ROUTES.POST_DOMAIN_SEARCH]: DomainSearchResult[];
    [API_ROUTES.POST_DOMAIN_CHECK]: DomainCheckResult[];
    [API_ROUTES.POST_DOMAIN_REQUEST]: DomainRequest | undefined;
    [API_ROUTES.POST_DOMAIN_REQUEST_DECIDE]: DomainRequest | undefined;
    [API_ROUTES.POST_DOMAIN_DELETE]: undefined;
    [API_ROUTES.POST_DOMAIN_ALLOCATIONS]: DomainAllocationResult;
    [API_ROUTES.POST_DOMAIN_ASSIGN]: undefined;
    [API_ROUTES.POST_DNS_RECORD_CREATE]: DnsRecord | undefined;
    [API_ROUTES.POST_DNS_RECORD_UPDATE]: DnsRecord | undefined;
    [API_ROUTES.POST_DNS_RECORD_DELETE]: undefined;
    [API_ROUTES.POST_PUBLIC_IP_REFRESH]: { ip: string | null; changed: boolean };
    [API_ROUTES.POST_NODE_CONFIG]: { ok: boolean };
}

export interface API_AUTH {
    // Set to string if it needs an auth token, leave out else
    //GET
    [API_ROUTES.GET_DEPLOY]: undefined;
    [API_ROUTES.GET_DEPLOY_WEB]: string;
    [API_ROUTES.GET_PROJECT]: string;
    [API_ROUTES.GET_PROJECTS]: string;
    [API_ROUTES.GET_PROJECT_INSTANCE]: string;
    [API_ROUTES.GET_WORKER_NODES]: string;
    [API_ROUTES.GET_WORKER_STATUSES]: string;
    [API_ROUTES.GET_JOIN_INFO]: string;
    [API_ROUTES.GET_CONTROL_PLANE_STATUS]: string;
    [API_ROUTES.GET_ME]: string;
    [API_ROUTES.GET_TEAMS]: string;
    [API_ROUTES.GET_TEAM]: string;
    [API_ROUTES.GET_ADMINS]: string;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: string;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: string;
    [API_ROUTES.GET_NODE_METRICS]: string;
    [API_ROUTES.GET_NODE_STORAGE]: string;
    [API_ROUTES.GET_NODE_STORAGE_SERIES]: string;
    [API_ROUTES.GET_NSM_LOGS]: string;
    [API_ROUTES.GET_GITHUB_OWNERS]: string;
    [API_ROUTES.GET_GITHUB_REPOS]: string;
    [API_ROUTES.GET_GITHUB_BRANCHES]: string;
    [API_ROUTES.GET_VAPID_PUBLIC_KEY]: string;
    [API_ROUTES.GET_PROJECT_NOTIFICATION]: string;
    [API_ROUTES.GET_PROJECT_RESOURCE_USAGE]: string;
    [API_ROUTES.GET_DOMAINS]: string;
    [API_ROUTES.GET_DOMAIN_REQUESTS]: string;
    [API_ROUTES.GET_DOMAIN_BILLING]: string;
    [API_ROUTES.GET_PUBLIC_IP]: string;
    [API_ROUTES.GET_DNS_RECORDS]: string;
    [API_ROUTES.GET_PROJECT_DOMAINS]: string;
    [API_ROUTES.GET_NODE_CONFIG]: string;

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: string;
    [API_ROUTES.POST_UPDATE_PROJECT]: string;
    [API_ROUTES.POST_DELETE_PROJECT]: string;
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: string;
    [API_ROUTES.POST_UPDATE_ENV_VAR]: string;
    [API_ROUTES.POST_SYNC_TO_REPO]: string;
    [API_ROUTES.POST_TEARDOWN_PROJECT]: string;
    [API_ROUTES.POST_CANCEL_DEPLOY]: string;
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: string;
    [API_ROUTES.POST_CICD_SETUP]: string;
    [API_ROUTES.POST_CICD_REMOVE]: string;
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: string;
    [API_ROUTES.POST_GITHUB_LOGIN]: undefined;
    [API_ROUTES.POST_GITHUB_LOGOUT]: string;
    [API_ROUTES.POST_SET_TEAM_DEFAULTS]: string;
    [API_ROUTES.POST_SET_TEAM_OVERRIDE]: string;
    [API_ROUTES.POST_DELETE_TEAM_OVERRIDE]: string;
    [API_ROUTES.POST_ADD_ADMIN]: string;
    [API_ROUTES.POST_REMOVE_ADMIN]: string;
    [API_ROUTES.POST_LOGGER]: undefined;
    [API_ROUTES.POST_PUSH_SUBSCRIBE]: string;
    [API_ROUTES.POST_PUSH_UNSUBSCRIBE]: string;
    [API_ROUTES.POST_SET_PROJECT_NOTIFICATION]: string;
    [API_ROUTES.POST_REGENERATE_VAPID]: string;
    [API_ROUTES.POST_LOG_QUERY]: string;
    [API_ROUTES.POST_LOG_FACETS]: string;
    [API_ROUTES.POST_NODE_STORAGE_SNAPSHOT]: string;
    [API_ROUTES.POST_SET_PROJECT_QUOTA]: string;
    [API_ROUTES.POST_DOMAIN_SEARCH]: string;
    [API_ROUTES.POST_DOMAIN_CHECK]: string;
    [API_ROUTES.POST_DOMAIN_REQUEST]: string;
    [API_ROUTES.POST_DOMAIN_REQUEST_DECIDE]: string;
    [API_ROUTES.POST_DOMAIN_DELETE]: string;
    [API_ROUTES.POST_DOMAIN_ALLOCATIONS]: string;
    [API_ROUTES.POST_DOMAIN_ASSIGN]: string;
    [API_ROUTES.POST_DNS_RECORD_CREATE]: string;
    [API_ROUTES.POST_DNS_RECORD_UPDATE]: string;
    [API_ROUTES.POST_DNS_RECORD_DELETE]: string;
    [API_ROUTES.POST_PUBLIC_IP_REFRESH]: string;
    [API_ROUTES.POST_NODE_CONFIG]: string;
}
