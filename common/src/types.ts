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
    // Snapshot of the managed CI/CD (GitHub Actions) workflow NSM provisioned for this project.
    // Absent when no managed workflow exists.
    cicd?: CdConfig;
    // Per-project resource allocation set by NSM admins. Advisory only (never enforced/blocked);
    // exceeding it notifies admins and team members. Absent means no allocation configured.
    resourceQuota?: ProjectResourceQuota;
}

// Admin-set advisory resource allocation for a project. Any subset may be set; an unset field means
// that resource is not capped. Canonical units: CPU cores, bytes for memory and storage.
export interface ProjectResourceQuota {
    cpuCores?: number;
    memoryBytes?: number;
    storageBytes?: number;
}

// Current measured resource usage for a project (CPU cores, bytes for memory and storage).
export interface ProjectResourceUsage {
    cpuCores: number;
    memoryBytes: number;
    storageBytes: number;
}
// Trigger types a managed GitHub Actions workflow can react to.
export enum CdTrigger {
    PUSH = 'push',
    PR_MERGE = 'pr_merge',
    RELEASE = 'release',
    TAG = 'tag',
    MANUAL = 'manual',
    SCHEDULE = 'schedule',
}

// Snapshot of the managed CI/CD workflow that NSM committed to a project's repository. Stored on the
// project so the UI can render current state and the backend can clean up on removal.
export interface CdConfig {
    managed: boolean;
    // Branch the workflow file is committed to (and, for PUSH, the branch that triggers deploys).
    branch: string;
    triggers: CdTrigger[];
    // Branches watched for PUSH / PR_MERGE triggers. Defaults to [branch] when omitted.
    branches?: string[];
    // Glob for TAG triggers (e.g. "v*").
    tagPattern?: string;
    // Cron expression for SCHEDULE triggers.
    cron?: string;
    // When true, the workflow was committed via a pull request rather than pushed directly.
    viaPr: boolean;
    // Path of the committed workflow file within the repo.
    workflowPath: string;
    // Name of the repo secret holding the deploy key.
    secretName: string;
    // URL of the pull request opened when viaPr is true.
    prUrl?: string;
    // SHA of the commit that added the workflow file (direct-push mode).
    commitSha?: string;
    setupAt: number;
}

// Body for POST /project/:projectId/cicd/setup.
export interface CdSetupRequest {
    branch: string;
    triggers: CdTrigger[];
    branches?: string[];
    tagPattern?: string;
    cron?: string;
    viaPr: boolean;
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
    // Epoch ms when this instance entered DEPLOYING (build start). Set by the leader on the
    // QUEUED -> DEPLOYING transition; used to compute deployDurationMs on success.
    deployStartedAt?: number;
    // Wall-clock build duration in ms (deployStartedAt -> DEPLOYED). Only set on a successful deploy,
    // so per-project rolling averages reflect real deploy time.
    deployDurationMs?: number;
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

// Transport protocol for a directly-forwarded (non-proxied) port reservation.
export enum PortProtocol {
    TCP = 'tcp',
    UDP = 'udp',
}

// A fixed host port on a specific node, reserved for exactly one project. Declared by an admin on a
// node's page to assert "this port+protocol is forwarded to this node for this project." NSM keeps
// the reserved port out of the dynamic proxy-port pool, injects `envVarName=port` into the project's
// deploy .env when it runs on this node, and can bind the port into DNS records (e.g. SRV data.port).
export interface PortReservation {
    id: string;
    nodeId: string;
    port: number;
    protocol: PortProtocol;
    projectId: string;
    envVarName: string;
    label?: string;
    created: number;
}

// Body for creating a port reservation on a node (node comes from the route path).
export interface CreatePortReservationBody {
    port: number;
    protocol: PortProtocol;
    projectId: string;
    envVarName: string;
    label?: string;
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
//
// When served to a user who lacks access to the entry's project, the entry is redacted to a
// placeholder that keeps only its position: `hidden` is true and `projectId`/`instanceId`/timestamps
// are cleared. This lets the UI show honest queue counts without leaking other teams' project ids.
export interface DeployQueueEntry {
    projectId: string;
    instanceId: string;
    enqueuedAt: number;
    hidden?: boolean;
    // Estimates derived from per-project rolling averages of recent successful deploys. All optional:
    // absent when the project has no deploy history yet (or the entry is redacted).
    //   estimatedDeployMs - how long this item's own deploy is expected to take.
    //   estimatedWaitMs   - time until this item reaches the top of the queue and begins deploying
    //                       (0 for the item that is currently deploying).
    //   avgSampleCount    - how many past deploys the estimate is based on (0 = fell back to a default).
    estimatedDeployMs?: number;
    estimatedWaitMs?: number;
    avgSampleCount?: number;
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

// === Project health / uptime tracking ===
// Deliberately generic (not tied to a single consumer) so the same samples can later drive
// deploy-readiness in addition to the status page and public API.
export enum HealthCheckType {
    URL = 'url', // HTTP/TLS probe of a public URL the project serves
    CONTAINER = 'container', // container actual-vs-expected state (from status gossip)
}

export enum HealthStatus {
    UP = 'up', // serving normally
    DEGRADED = 'degraded', // answering but impaired (e.g. TLS cert problem)
    DOWN = 'down', // not serving
    UNKNOWN = 'unknown', // no data yet
}

// One recorded observation of a single check target at a point in time.
export interface ProjectHealthSample {
    id: string;
    projectId: string;
    checkType: HealthCheckType;
    target: string; // full URL for URL checks; service name for container checks
    status: HealthStatus;
    latencyMs?: number;
    detail?: string;
    ts: number;
}

// The latest observed state of a single check target (drives the current-status cards).
export interface ProjectHealthCheck {
    checkType: HealthCheckType;
    target: string;
    status: HealthStatus;
    latencyMs?: number;
    detail?: string;
    ts: number;
}

export type UptimeWindowKey = '24h' | '7d' | '30d' | '90d';

// Uptime ratio ("nines") over a rolling window.
export interface UptimeWindowSummary {
    window: UptimeWindowKey;
    uptimeRatio: number; // 0..1 (fraction of samples not DOWN)
    sampleCount: number;
}

// One heatmap cell: aggregated health over a contiguous time bucket.
export interface UptimeBucket {
    start: number;
    end: number;
    status: HealthStatus;
    upRatio: number; // 0..1
    sampleCount: number;
}

// Everything the status page and public API need for one project.
export interface ProjectHealthSummary {
    projectId: string;
    overall: HealthStatus;
    checks: ProjectHealthCheck[];
    windows: UptimeWindowSummary[];
    buckets: UptimeBucket[];
    bucketWindow: UptimeWindowKey;
    generatedAt: number;
}

// === Incidents & scheduled maintenance ===
// An incident is an unplanned disruption; a maintenance is a planned (often future-dated) one.
export enum IncidentKind {
    INCIDENT = 'incident',
    MAINTENANCE = 'maintenance',
}

// Incident lifecycle mirrors incident.io-style status pages. The first four apply to incidents; the
// last three to scheduled maintenance.
export enum IncidentStatus {
    INVESTIGATING = 'investigating',
    IDENTIFIED = 'identified',
    MONITORING = 'monitoring',
    RESOLVED = 'resolved',
    SCHEDULED = 'scheduled',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
}

export enum IncidentImpact {
    NONE = 'none',
    MINOR = 'minor',
    MAJOR = 'major',
    CRITICAL = 'critical',
}

export interface Incident {
    id: string;
    projectId: string;
    kind: IncidentKind;
    title: string;
    status: IncidentStatus;
    impact: IncidentImpact;
    startedAt: number;
    resolvedAt?: number;
    // Planned maintenance window (only for kind === MAINTENANCE).
    scheduledStart?: number;
    scheduledEnd?: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}

// A timeline entry appended to an incident (status change + human-readable note).
export interface IncidentUpdate {
    id: string;
    incidentId: string;
    status: IncidentStatus;
    body: string;
    createdBy: string;
    createdAt: number;
}

export interface IncidentWithUpdates {
    incident: Incident;
    updates: IncidentUpdate[];
}

export interface CreateIncidentBody {
    kind: IncidentKind;
    title: string;
    impact: IncidentImpact;
    status: IncidentStatus;
    body?: string; // optional initial timeline note
    startedAt?: number;
    scheduledStart?: number;
    scheduledEnd?: number;
}

export interface AddIncidentUpdateBody {
    status: IncidentStatus;
    body: string;
}

export interface UpdateIncidentBody {
    title?: string;
    impact?: IncidentImpact;
    status?: IncidentStatus;
    scheduledStart?: number;
    scheduledEnd?: number;
}

// === Project API keys ===
// Fine-grained permissions a project API key can be granted. Only GET_STATUS exists today; this is
// intentionally an enum so future capabilities (config edits, log access, etc.) can be added.
export enum ApiKeyPermission {
    GET_STATUS = 'get_status',
}

// Stored API key. The raw secret is never persisted - only a SHA-256 hash and a short display
// prefix. The full key is shown to the creator exactly once.
export interface ApiKey {
    id: string;
    projectId: string;
    name: string;
    prefix: string;
    hashedKey: string;
    permissions: ApiKeyPermission[];
    createdBy: string;
    createdAt: number;
    lastUsedAt?: number;
    revokedAt?: number;
}

// Safe projection sent to the UI (never includes the hash).
export type ApiKeyView = Omit<ApiKey, 'hashedKey'>;

export interface CreateApiKeyBody {
    name: string;
    permissions: ApiKeyPermission[];
}

// Returned once on creation: the metadata plus the plaintext secret to copy.
export interface CreateApiKeyResult {
    key: ApiKeyView;
    secret: string;
}

// The public JSON payload served to authenticated API-key holders.
export interface PublicProjectStatus {
    projectId: string;
    health: ProjectHealthSummary;
    incidents: IncidentWithUpdates[];
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
    MANAGE_INCIDENTS = 'manage_incidents', // create/update incidents + scheduled maintenance
}

// Every capability, granted to admins / owners (absolute power).
export const ALL_CAPABILITIES: Capability[] = [Capability.VIEW, Capability.DEPLOY, Capability.CONFIGURE, Capability.DELETE, Capability.CREATE_PROJECT, Capability.MANAGE_INCIDENTS];

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

// === Cloudflare DNS + Domains ===

// The DNS record types NSM offers rich editing for. The backend passes `type` straight through to
// Cloudflare, so any type Cloudflare accepts still works even if it is not in this list.
export type DnsRecordType =
    | 'A'
    | 'AAAA'
    | 'CNAME'
    | 'MX'
    | 'TXT'
    | 'SRV'
    | 'NS'
    | 'CAA'
    | 'PTR'
    | 'CERT'
    | 'DNSKEY'
    | 'DS'
    | 'HTTPS'
    | 'LOC'
    | 'NAPTR'
    | 'SMIMEA'
    | 'SSHFP'
    | 'SVCB'
    | 'TLSA'
    | 'URI';

export const DNS_RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'CERT', 'DNSKEY', 'DS', 'HTTPS', 'LOC', 'NAPTR', 'SMIMEA', 'SSHFP', 'SVCB', 'TLSA', 'URI'];

// Record types whose value Cloudflare represents as a structured `data` object rather than flat
// `content` (SRV/CAA/etc.). Simple types (A/AAAA/CNAME/TXT/NS/MX...) use `content`.
export const DNS_STRUCTURED_TYPES: DnsRecordType[] = ['SRV', 'CAA', 'LOC', 'NAPTR', 'SSHFP', 'TLSA', 'SMIMEA', 'DS', 'CERT', 'HTTPS', 'SVCB'];

// A DNS record mirrored from Cloudflare (Cloudflare is authoritative). `data` carries structured
// fields for record types that use them; `content` is the flat value for simple types.
export interface DnsRecord {
    id: string;
    zoneId: string;
    type: DnsRecordType;
    name: string; // full record name (FQDN)
    content: string;
    proxied?: boolean;
    ttl: number; // 1 = automatic
    priority?: number;
    data?: Record<string, unknown>;
    comment?: string;
    // True when NSM manages this record's content as the dynamic public IP (tagged via the CF
    // record comment, so the flag lives in Cloudflare and survives re-sync).
    dynamic?: boolean;
    // When set, NSM drives this record's port (e.g. SRV data.port) from the given port reservation.
    // Like `dynamic`, the binding is tagged in the CF record comment so Cloudflare stays authoritative.
    portReservationId?: string;
}

// The registrar/billing side of a domain, present when the zone is a Cloudflare Registrar domain.
export interface DomainBilling {
    expiresAt?: string;
    autoRenew?: boolean;
    registrationCost?: string;
    renewalCost?: string;
    currency?: string;
    registrationStatus?: string; // active | registration_pending | expired | ...
}

// A DNS zone (domain) on the Cloudflare account, mirrored into NSM plus its NSM-side associations.
export interface DnsZone {
    id: string;
    name: string;
    status: string; // active | pending | moved | ...
    paused: boolean;
    billing?: DomainBilling;
    // NSM-side associations (durable, replicated via ops).
    assignedProjectId?: string;
    allocatedTeamIds?: string[]; // team ownerIds
    recordCount?: number;
    lastSyncedAt?: number;
}

// A domain-search suggestion (non-authoritative, from Cloudflare's registrar search endpoint).
export interface DomainSearchResult {
    name: string;
    registrable: boolean;
    tier?: 'standard' | 'premium';
    currency?: string;
    registrationCost?: string;
    renewalCost?: string;
    reason?: string;
}

// An authoritative availability/price check for a single domain (from registrar domain-check).
export type DomainCheckResult = DomainSearchResult;

export enum DomainRequestStatus {
    PENDING = 'pending',
    DENIED = 'denied',
    PURCHASING = 'purchasing',
    PURCHASED = 'purchased',
    FAILED = 'failed',
}

// A request by a non-super-admin to purchase a domain. Only the super admin may approve (buy) or
// deny it. Price is snapshotted at request time so the approver sees what was quoted.
export interface DomainRequest {
    id: string;
    domainName: string;
    requesterId: string; // github id
    requesterLogin: string;
    ownerId?: string; // target team to allocate the domain to on purchase
    ownerLogin?: string;
    priceCurrency?: string;
    priceRegistration?: string;
    priceRenewal?: string;
    status: DomainRequestStatus;
    decidedById?: string;
    decidedByLogin?: string;
    reason?: string; // denial reason or failure detail
    createdAt: number;
    updatedAt: number;
}

// Per-domain team allocation (which teams may use a domain in their project config).
export interface DomainTeamAllocation {
    zoneId: string;
    ownerId: string;
}

// Billing rollup for the domains page. Totals are grouped by currency since domains may bill in
// different currencies.
export interface DomainBillingEntry {
    zoneId: string;
    name: string;
    renewalCost?: string;
    currency?: string;
    expiresAt?: string;
    autoRenew?: boolean;
}
export interface DomainBillingSummary {
    entries: DomainBillingEntry[];
    totalsByCurrency: { currency: string; monthly: number; yearly: number }[];
}

// Result of a team-allocation change: when `ok` is false, `blockedBy` lists the projects still using
// the domain that prevented removing a team's access.
export interface DomainAllocationResult {
    ok: boolean;
    blockedBy?: { projectId: string; ownerLogin: string }[];
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

// === Per-node storage spec ===
// Host-level metric kinds charted per node. 'disk' is total used bytes across real filesystems.
export type NodeMetricKind = 'cpu' | 'mem' | 'net' | 'disk';

// One mounted filesystem ("hard drive") on a node and its capacity/usage.
export interface NodeFilesystemUsage {
    device: string;
    mountpoint: string;
    fstype: string;
    sizeBytes: number;
    usedBytes: number;
    availBytes: number;
}

// A single project's disk footprint on one filesystem, split into its persistent volume and its
// deployed code. totalBytes is volumeBytes + codeBytes.
export interface ProjectDiskUsage {
    projectId: string;
    device: string;
    mountpoint: string;
    volumeBytes: number;
    codeBytes: number;
    totalBytes: number;
}

// Full storage picture for one node: every filesystem plus the per-project breakdown on each.
export interface NodeStorageSpec {
    nodeId: string;
    capturedAt: number; // unix ms
    filesystems: NodeFilesystemUsage[];
    projects: ProjectDiskUsage[];
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
