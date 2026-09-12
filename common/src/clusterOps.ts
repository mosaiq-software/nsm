import { AllowedGithubEntity, Project, ProjectServiceInstance, Secret, User } from './types';

// Static description of a peer in the cluster. Identity is nodeId; address is the current IP.
export interface NodeInfo {
    nodeId: string;
    address: string;
    apiPort: number;
}

export interface PortPlanEntry {
    proxyLocationId: string;
    port: number;
    // Optional HTTP path to probe on `port` during the zero-downtime readiness gate (from the proxy
    // location's readinessPath). When unset the node uses a bare TCP connect.
    readinessPath?: string;
}

// A fully-rendered, self-contained description of what a node must run for a project.
// Produced by the leader; applied by the owning node's reconciler.
export interface DesiredDeployment {
    projectId: string;
    generation: number;
    assignedNodeId: string;
    repoOwner: string;
    repoName: string;
    repoBranch?: string;
    timeout: number;
    logId: string;
    dotenv: string;
    compose: string;
    // The pending generation's nginx conf + domains (what nginx should serve AFTER the new stack
    // passes its readiness gate and the leader promotes it).
    nginxConf: string;
    domains: string[];
    services: ProjectServiceInstance[];
    // Whether this deployment uses the zero-downtime (blue-green) lifecycle. Stamped by the leader
    // from the global config AND the project's opt-out. When false, the node recreates in place and
    // the leader flips nginx immediately (legacy behavior).
    zeroDowntime: boolean;
    // Per-proxy host ports allocated for THIS generation, so the owning node can probe them as part
    // of the readiness gate before reporting the generation ready.
    ports: PortPlanEntry[];
    // The generation nginx should currently serve. For zero-downtime this trails `generation` until
    // the node reports the new generation ready and the leader promotes it. For the legacy path it
    // equals `generation` immediately. Undefined before the first successful cutover.
    activeGeneration?: number;
    // The nginx conf + domains for `activeGeneration` (what the leader actually renders). Kept
    // separate from the pending `nginxConf`/`domains` so old ports keep serving until cutover.
    activeNginxConf?: string;
    activeDomains?: string[];
}

export interface CertRecord {
    domain: string;
    notAfter: number;
    // Cert material is served to nginx directly from LETSENCRYPT_LIVE_DIR and is not replicated, so
    // these are optional: the leader records only expiry (notAfter) for cheap renewal checks.
    fullchainPem?: string;
    privkeyPem?: string;
}

// === State mutations applied directly to the leader's source-of-truth DB (via applyOp). ===
// Node membership is handled by the registry (not ops); certs are leader-local (not replicated).
export enum OpType {
    UPSERT_PROJECT = 'UPSERT_PROJECT',
    DELETE_PROJECT = 'DELETE_PROJECT',
    SET_PROJECT_SECRETS = 'SET_PROJECT_SECRETS',
    UPSERT_SECRET = 'UPSERT_SECRET',
    SET_PROJECT_ASSIGNMENT = 'SET_PROJECT_ASSIGNMENT',
    SET_DESIRED_DEPLOYMENT = 'SET_DESIRED_DEPLOYMENT',
    CLEAR_DESIRED_DEPLOYMENT = 'CLEAR_DESIRED_DEPLOYMENT',
    SET_DESIRED_NSM_VERSION = 'SET_DESIRED_NSM_VERSION',
    UPSERT_USER = 'UPSERT_USER',
    SET_ALLOWED_ENTITIES = 'SET_ALLOWED_ENTITIES',
}

export type Op =
    | { type: OpType.UPSERT_PROJECT; project: Project }
    | { type: OpType.DELETE_PROJECT; projectId: string }
    | { type: OpType.SET_PROJECT_SECRETS; projectId: string; secrets: Secret[] }
    | { type: OpType.UPSERT_SECRET; secret: Secret }
    | { type: OpType.SET_PROJECT_ASSIGNMENT; projectId: string; nodeId: string }
    | { type: OpType.SET_DESIRED_DEPLOYMENT; deployment: DesiredDeployment }
    | { type: OpType.CLEAR_DESIRED_DEPLOYMENT; projectId: string }
    | { type: OpType.SET_DESIRED_NSM_VERSION; version: string; artifactRef: string }
    | { type: OpType.UPSERT_USER; user: User }
    | { type: OpType.SET_ALLOWED_ENTITIES; entities: AllowedGithubEntity[] };
