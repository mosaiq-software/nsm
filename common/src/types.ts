import { DockerCompose } from './dockerComposeTypes';

export interface Project {
    id: string;
    repoOwner: string;
    repoName: string;
    repoBranch?: string;
    state?: DeploymentState;
    deploymentKey?: string;
    createdAt?: string;
    updatedAt?: string;
    allowCICD?: boolean;
    secrets?: Secret[];
    instances?: ProjectInstanceHeader[];
    timeout?: number;
    dirtyConfig?: boolean;
    nginxConfig?: ProjectNginxConfig;
    dockerCompose?: DockerCompose;
    services?: ProjectService[];
    workerNodeId?: string;
    hasDockerCompose?: boolean;
    hasDotenv?: boolean;
    // Per-project opt-out for zero-downtime (blue-green) deploys. Undefined inherits the global
    // default (ZERO_DOWNTIME_DEPLOYS, on by default); set to false to force in-place recreation.
    zeroDowntime?: boolean;
}

export interface Secret {
    projectId: string;
    secretName: string;
    secretValue: string;
    secretPlaceholder: string;
    variable: boolean;
    // Comments scraped from the project's .env file: the `#` lines directly above the variable plus
    // any inline trailing `#` comment. Shown as a subtitle in the UI. Only set for .env-sourced vars.
    comment?: string;
}

export interface ProjectInstanceHeader {
    id: string;
    projectId: string;
    workerNodeId: string;
    state: DeploymentState;
    created: number;
    lastUpdated: number;
    active: boolean;
    directories: FullDirectoryMap;
}
export interface ProjectInstance extends ProjectInstanceHeader {
    deploymentLog: string;
    services: ProjectServiceInstance[];
}

export enum DeploymentState {
    READY = 'ready',
    QUEUED = 'queued',
    DEPLOYING = 'deploying',
    FAILED = 'failed',
    DEPLOYED = 'deployed',
    HEALTHY = 'healthy',
    DESTROYING = 'destroying',
    CANCELLED = 'cancelled',
}

export interface DeployableProject {
    projectId: string;
    repoOwner: string;
    repoName: string;
    repoBranch: string | undefined;
    timeout: number;
    logId: string;
    dotenv: string;
    compose: string;
    services: ProjectServiceInstance[];
}
export interface DeployableControlPlaneConfig {
    projectId: string;
    nginxConf: string;
    domainsToCertify: string[];
    logId: string;
}

export interface DeploymentLogUpdate {
    logId: string;
    status: DeploymentState;
    log: string;
}

// === Cluster membership / status (leader-hosted registry, no raft/VIP) ===
export interface ClusterNode {
    nodeId: string;
    address: string;
    apiPort: number;
    lastSeen: number;
    isLeader: boolean;
}

export enum NodeRole {
    LEADER = 'leader',
    FOLLOWER = 'follower',
}

export interface NodeHealth {
    nodeId: string;
    reachable: boolean;
    nsmVersion: string;
    isLeader: boolean;
    lastSeen: number;
}

// A single project waiting in (or actively being processed by) the leader's deploy queue. Only the
// leader deploys, so the queue is leader-local; `instanceId` is the ProjectInstance/log id created
// at enqueue time so the UI can watch a deploy from the moment it is queued.
export interface DeployQueueEntry {
    projectId: string;
    instanceId: string;
    enqueuedAt: number;
}

// Snapshot of the leader's deploy queue: at most one entry occupies the leader's planning slot
// (`active`), the rest wait in `queued` order. `deploying` lists the instances actually being built
// on their assigned nodes (ProjectInstances in DEPLOYING state) - this outlives the brief planning
// slot, so the UI can pin a "Deploying" row for the whole build.
export interface DeployQueueState {
    active: (DeployQueueEntry & { startedAt: number }) | null;
    queued: DeployQueueEntry[];
    deploying: (DeployQueueEntry & { startedAt: number })[];
}

export interface ClusterStatus {
    leaderId: string | null;
    nodes: ClusterNode[];
    health: NodeHealth[];
    desiredNsmVersion: string | null;
    deployQueue?: DeployQueueState;
}

export interface NodeContainerStatus {
    serviceInstanceId: string;
    state: DockerStatus;
    containerId?: string;
}

export interface NodeStatusReport {
    nodeId: string;
    nsmVersion: string;
    healthy: boolean;
    currentAddress: string;
    apiPort: number;
    containers: NodeContainerStatus[];
    ts: number;
}

export enum NginxConfigLocationType {
    STATIC = 'static',
    PROXY = 'proxy',
    REDIRECT = 'redirect',
    CUSTOM = 'custom',
}

export interface StaticConfigLocation {
    locationId: string;
    type: NginxConfigLocationType.STATIC;
    path: string;
    serveDir: string;
    spa: boolean;
    explicitCors: boolean;
}
export interface ProxyConfigLocation {
    locationId: string;
    type: NginxConfigLocationType.PROXY;
    path: string;
    proxyPass: string;
    websocketSupport: boolean;
    timeout?: number;
    maxClientBodySizeMb?: number;
    replications?: number;
    // Optional HTTP path probed on the newly allocated port during a zero-downtime deploy to decide
    // the new generation is ready before nginx is flipped to it. When unset, a TCP connect is used.
    readinessPath?: string;
}
export interface RedirectConfigLocation {
    locationId: string;
    type: NginxConfigLocationType.REDIRECT;
    path: string;
    target: string;
}
export interface CustomConfigLocation {
    locationId: string;
    type: NginxConfigLocationType.CUSTOM;
    path: string;
    content: string;
}
export type ConfigLocation = StaticConfigLocation | ProxyConfigLocation | RedirectConfigLocation | CustomConfigLocation;
export interface ServerConfig {
    serverId: string;
    domain: string;
    wildcardSubdomain: boolean;
    locations: ConfigLocation[];
}

export interface ProjectNginxConfig {
    servers: ServerConfig[];
}

export enum UpperDynamicEnvVariableType {
    GENERAL = 'general',
    DOMAIN = 'domain',
}
export type DynamicEnvVariableType = UpperDynamicEnvVariableType | NginxConfigLocationType;
export enum DynamicEnvVariableFields {
    WORKER_NODE_ID = 'WorkerNodeId',
    DOMAIN = 'Domain',
    URL = 'URL',
    PATH = 'Path',
    DIRECTORY = 'Directory',
    PORT = 'Port',
    TARGET = 'Target',
    VOLUME = 'Volume',
}
export interface DynamicEnvVariable {
    path: string;
    type: DynamicEnvVariableType;
    placeholder?: string;
}

export type DirectoryBase = 'persistent' | 'deploy';
export interface RelativeDirectoryMap {
    [dynVarPath: string]: { relPath: string; base?: DirectoryBase };
}
export interface FullDirectoryMap {
    [dynVarPath: string]: { fullPath: string };
}

export enum UriStatus {
    UNKNOWN = 'unknown', // initial state, not yet checked
    REACHABLE = 'reachable', // last check was successful, 100-300
    UNREACHABLE = 'unreachable', // last check failed
    ERROR = 'error', // last check resulted in an error 400-599
}
export enum DockerStatus {
    UNKNOWN = 'unknown', // initial state, not yet checked
    CREATED = 'created', // A container that has never been started.
    RUNNING = 'running', // A running container, started by either docker start or docker run.
    PAUSED = 'paused', // A paused container. See docker pause.
    RESTARTING = 'restarting', // A container which is starting due to the designated restart policy for that container.
    EXITED = 'exited', // A container which is no longer running. For example, the process inside the container completed or the container was stopped using the docker stop command.
    REMOVING = 'removing', // A container which is in the process of being removed. See docker rm.
    DEAD = 'dead', // A "defunct" container; for example, a container that was only partially removed because resources were kept busy by an external process. dead containers cannot be (re)started, only removed.
}

export interface ProjectService {
    serviceName: string;
    expectedContainerState: DockerStatus;
    collectContainerLogs: boolean;
}
export interface ProjectServiceInstance extends ProjectService {
    instanceId: string;
    projectInstanceId: string;
    containerId: string | undefined;
    actualContainerState: DockerStatus;
    containerLogs: string;
    created: number;
    lastUpdated: number;
}

export interface DockerContainerData {
    Command: string;
    CreatedAt: string;
    ID: string;
    Image: string;
    Labels: { [key: string]: string };
    LocalVolumes: string;
    Mounts: string;
    Names: string;
    Networks: string;
    Ports: string;
    RunningFor: string;
    Size: string;
    State: string;
    Status: string;
}

export interface User {
    name: string;
    githubId: string;
    avatarUrl: string;
    authToken: string;
    created: number;
    signedIn: boolean;
}

// A browser Web Push subscription, as produced by PushManager.subscribe().toJSON() on the client.
// Stored per user so the leader can push deploy notifications to every opted-in browser.
export interface PushSubscriptionJSON {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}

export enum AllowedEntityType {
    USER = 'user',
    ORGANIZATION = 'organization',
}
export interface AllowedGithubEntity {
    id: string;
    type: AllowedEntityType;
    avatarUrl: string;
}

// A user/org that has installed the NSM GitHub App, surfaced as create-project suggestions.
export interface GithubOwner {
    id: string; // GitHub numeric account id (stable across login renames)
    login: string;
    type: string; // 'User' | 'Organization'
    avatarUrl: string;
}

// === Access control (admins, teams, capabilities) ===

// The set of actions a member can be granted within a team. Simple checkbox capabilities (no role
// builder). CREATE_PROJECT is team-scoped; the rest are evaluated per project. Any non-empty grant
// implies VIEW (you cannot act on something you cannot see).
export enum Capability {
    VIEW = 'view',
    DEPLOY = 'deploy', // see logs + trigger deploy/teardown/cancel
    CONFIGURE = 'configure', // edit config + env vars + repo settings
    DELETE = 'delete', // delete the project
    CREATE_PROJECT = 'create_project', // create a project within the team
}

// Every capability, granted to admins / owners (absolute power).
export const ALL_CAPABILITIES: Capability[] = [Capability.VIEW, Capability.DEPLOY, Capability.CONFIGURE, Capability.DELETE, Capability.CREATE_PROJECT];

export enum TeamType {
    ORGANIZATION = 'organization',
    USER = 'user',
}

// Reserved synthetic team that holds projects whose repo owner has no current App installation and
// no stored config. Visible to the super admin only.
export const ORPHAN_TEAM_ID = '__orphan__';

// Stored team configuration, keyed by the owner's stable GitHub account id. Never deleted when the
// App is uninstalled; `login` is refreshed from installations for display.
export interface TeamConfig {
    ownerId: string;
    login: string;
    type: TeamType;
    defaultCapabilities: Capability[];
}

// Stored per-member permission override, keyed by (ownerId, memberId) using stable GitHub ids so it
// survives a member leaving and rejoining the org. Additive-only: unioned with the team default.
export interface TeamMemberOverride {
    ownerId: string;
    memberId: string;
    memberLogin: string;
    capabilities: Capability[];
}

// A stored NSM admin (individual GitHub user). The super admin (env) is implicit and not stored.
export interface Admin {
    id: string; // GitHub account id
    login: string;
    avatarUrl: string;
}

// Derived team view = installation state merged with stored config.
export interface Team {
    ownerId: string;
    login: string;
    type: TeamType;
    installed: boolean;
    defaultCapabilities: Capability[];
}

// A team member surfaced in the team-detail editor.
export interface TeamMember {
    id: string;
    login: string;
    avatarUrl: string;
    isOwner: boolean; // org owner -> absolute permissions
    override: Capability[] | null; // null = no explicit override
    effective: Capability[];
}

// Full team detail for the admin/owner editor.
export interface TeamDetail {
    team: Team;
    members: TeamMember[];
    canManage: boolean; // whether the requester may edit defaults/overrides
}

// One team as seen by the signed-in user, driving the sidebar.
export interface MeTeam {
    ownerId: string;
    login: string;
    type: TeamType;
    installed: boolean;
    isOwner: boolean;
    capabilities: Capability[];
    projects: { id: string; capabilities: Capability[] }[];
}

// GET /me: everything the UI needs to render permission-aware navigation.
export interface MeResponse {
    user: User;
    isSuperAdmin: boolean;
    isAdmin: boolean;
    teams: MeTeam[];
}

export enum LogLevel {
    ERROR = 'error',
    WARN = 'warn',
    INFO = 'info',
    DEBUG = 'debug',
}

export interface LogMessage {
    time: number;
    lvl: LogLevel;
    msg: string;
}

// === Observability query results (proxied from Loki / Prometheus by the leader) ===
export interface ObservabilityLogLine {
    ts: string; // nanosecond epoch string from Loki
    line: string;
    labels: { [k: string]: string };
}
export interface ObservabilityLogsResult {
    lines: ObservabilityLogLine[];
}
export interface ObservabilityMetricSample {
    t: number; // unix seconds
    v: number;
}
export interface ObservabilityMetricsResult {
    metric: string;
    series: { labels: { [k: string]: string }; values: ObservabilityMetricSample[] }[];
}

// === Structured log query (Datadog-style viewer) ===
// Identifies which log stream to query. `source: 'nsmd'` targets the control-plane (pino JSON) logs;
// the project selectors target a deployment's app-container logs (raw text). Mutually exclusive in
// practice - the most specific one provided wins (see labelSelector precedence in the backend).
export interface LogSelector {
    source?: 'nsmd';
    projectId?: string;
    projectInstanceId?: string;
    serviceInstanceId?: string;
}

// A structured filter applied to a parsed field after `| json` (e.g. area="reconcile"). `field` is a
// pino/JSON field name or a Loki label; `op` maps to LogQL label-filter operators.
export interface LogFilter {
    field: string;
    op: 'eq' | 'neq' | 'match' | 'nmatch';
    value: string;
}

export interface LogQueryRequest {
    selector: LogSelector;
    startNs: string;
    endNs: string;
    // Free-text search -> LogQL line filter (|=).
    search?: string;
    // Structured field filters -> LogQL label filters after `| json`.
    filters?: LogFilter[];
    // Minimum pino numeric level (10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal).
    levelMin?: number;
    // Page size.
    limit?: number;
    // Backward pagination cursor: return entries strictly older than this nanosecond timestamp.
    cursorNs?: string;
}

// A single log entry. `fields` is the parsed JSON object for pino/nsmd logs (absent for raw text).
export interface LogEntry {
    ts: string;
    line: string;
    labels: { [k: string]: string };
    fields?: { [k: string]: unknown };
}

export interface LogQueryResult {
    entries: LogEntry[];
    // Cursor to pass as `cursorNs` to fetch the next (older) page; absent when no more entries.
    nextCursorNs?: string;
}

export interface LogFacetsRequest {
    selector: LogSelector;
    startNs: string;
    endNs: string;
    search?: string;
    filters?: LogFilter[];
    levelMin?: number;
    // Fields to compute value counts for (e.g. ['level','area','action','nodeId']).
    fields: string[];
}

export interface LogFacetValue {
    value: string;
    count: number;
}

export interface LogFacet {
    field: string;
    values: LogFacetValue[];
}

export interface LogFacetsResult {
    facets: LogFacet[];
    total: number;
}
