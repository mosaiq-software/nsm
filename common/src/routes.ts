import { AllowedGithubEntity, ClusterNode, ClusterStatus, DeploymentLogUpdate, DeploymentState, GithubOwner, LogMessage, ObservabilityLogsResult, ObservabilityMetricsResult, Project, ProjectInstance, Secret, User } from './types';

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
    GET_ALLOWED_ENTITIES = '/allowed-entities',
    GET_OBSERVABILITY_LOGS = '/observability/logs',
    GET_OBSERVABILITY_METRICS = '/observability/metrics',
    GET_GITHUB_OWNERS = '/github/owners',
    GET_GITHUB_REPOS = '/github/repos',
    GET_GITHUB_BRANCHES = '/github/branches',

    //POST
    POST_CREATE_PROJECT = '/project/create',
    POST_UPDATE_PROJECT = '/project/:projectId/update',
    POST_DELETE_PROJECT = '/project/:projectId/delete',
    POST_RESET_DEPLOYMENT_KEY = '/project/:projectId/reset-key',
    POST_UPDATE_ENV_VAR = '/project/:projectId/updateEnvVar',
    POST_SYNC_TO_REPO = '/project/:projectId/sync-to-repo',
    POST_TEARDOWN_PROJECT = '/project/:projectId/teardown',
    POST_SET_PROJECT_ASSIGNMENT = '/project/:projectId/assign',
    POST_DEPLOYMENT_LOG_UPDATE = '/deploy/update',
    POST_GITHUB_LOGIN = '/login/github/:token',
    POST_GITHUB_LOGOUT = '/logout/github/:token',
    POST_SET_ALLOWED_ENTITIES = '/allowed-entities/set',
    POST_LOGGER = '/logger/:logKey',
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
    [API_ROUTES.GET_ALLOWED_ENTITIES]: {};
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: {};
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: {};
    [API_ROUTES.GET_GITHUB_OWNERS]: {};
    [API_ROUTES.GET_GITHUB_REPOS]: {};
    [API_ROUTES.GET_GITHUB_BRANCHES]: {};

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: {};
    [API_ROUTES.POST_UPDATE_PROJECT]: { projectId: string };
    [API_ROUTES.POST_DELETE_PROJECT]: { projectId: string };
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: { projectId: string };
    [API_ROUTES.POST_UPDATE_ENV_VAR]: { projectId: string };
    [API_ROUTES.POST_SYNC_TO_REPO]: { projectId: string };
    [API_ROUTES.POST_TEARDOWN_PROJECT]: { projectId: string };
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: { projectId: string };
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: {};
    [API_ROUTES.POST_GITHUB_LOGIN]: { token: string };
    [API_ROUTES.POST_GITHUB_LOGOUT]: { token: string };
    [API_ROUTES.POST_SET_ALLOWED_ENTITIES]: {};
    [API_ROUTES.POST_LOGGER]: { logKey: string };
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
    [API_ROUTES.GET_ALLOWED_ENTITIES]: undefined;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: undefined;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: undefined;
    [API_ROUTES.GET_GITHUB_OWNERS]: undefined;
    [API_ROUTES.GET_GITHUB_REPOS]: undefined;
    [API_ROUTES.GET_GITHUB_BRANCHES]: undefined;

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: Project;
    [API_ROUTES.POST_UPDATE_PROJECT]: Partial<Project>;
    [API_ROUTES.POST_DELETE_PROJECT]: {};
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: {};
    [API_ROUTES.POST_UPDATE_ENV_VAR]: Secret;
    [API_ROUTES.POST_SYNC_TO_REPO]: {};
    [API_ROUTES.POST_TEARDOWN_PROJECT]: {};
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: { nodeId: string };
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: DeploymentLogUpdate;
    [API_ROUTES.POST_GITHUB_LOGIN]: {};
    [API_ROUTES.POST_GITHUB_LOGOUT]: {};
    [API_ROUTES.POST_SET_ALLOWED_ENTITIES]: { entities: AllowedGithubEntity[] };
    [API_ROUTES.POST_LOGGER]: LogMessage;
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
    [API_ROUTES.GET_ALLOWED_ENTITIES]: AllowedGithubEntity[] | undefined;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: ObservabilityLogsResult | undefined;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: ObservabilityMetricsResult | undefined;
    [API_ROUTES.GET_GITHUB_OWNERS]: GithubOwner[];
    [API_ROUTES.GET_GITHUB_REPOS]: string[];
    [API_ROUTES.GET_GITHUB_BRANCHES]: string[];

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: Project;
    [API_ROUTES.POST_UPDATE_PROJECT]: undefined;
    [API_ROUTES.POST_DELETE_PROJECT]: undefined;
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: string | undefined;
    [API_ROUTES.POST_UPDATE_ENV_VAR]: undefined;
    [API_ROUTES.POST_SYNC_TO_REPO]: Project | undefined;
    [API_ROUTES.POST_TEARDOWN_PROJECT]: undefined;
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: undefined;
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: undefined;
    [API_ROUTES.POST_GITHUB_LOGIN]: User | undefined;
    [API_ROUTES.POST_GITHUB_LOGOUT]: undefined;
    [API_ROUTES.POST_SET_ALLOWED_ENTITIES]: undefined;
    [API_ROUTES.POST_LOGGER]: undefined;
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
    [API_ROUTES.GET_ALLOWED_ENTITIES]: string;
    [API_ROUTES.GET_OBSERVABILITY_LOGS]: string;
    [API_ROUTES.GET_OBSERVABILITY_METRICS]: string;
    [API_ROUTES.GET_GITHUB_OWNERS]: string;
    [API_ROUTES.GET_GITHUB_REPOS]: string;
    [API_ROUTES.GET_GITHUB_BRANCHES]: string;

    //POST
    [API_ROUTES.POST_CREATE_PROJECT]: string;
    [API_ROUTES.POST_UPDATE_PROJECT]: string;
    [API_ROUTES.POST_DELETE_PROJECT]: string;
    [API_ROUTES.POST_RESET_DEPLOYMENT_KEY]: string;
    [API_ROUTES.POST_UPDATE_ENV_VAR]: string;
    [API_ROUTES.POST_SYNC_TO_REPO]: string;
    [API_ROUTES.POST_TEARDOWN_PROJECT]: string;
    [API_ROUTES.POST_SET_PROJECT_ASSIGNMENT]: string;
    [API_ROUTES.POST_DEPLOYMENT_LOG_UPDATE]: string;
    [API_ROUTES.POST_GITHUB_LOGIN]: undefined;
    [API_ROUTES.POST_GITHUB_LOGOUT]: string;
    [API_ROUTES.POST_SET_ALLOWED_ENTITIES]: string;
    [API_ROUTES.POST_LOGGER]: undefined;
}
