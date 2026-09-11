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
    nginxConf: string;
    domains: string[];
    services: ProjectServiceInstance[];
}

export interface CertRecord {
    domain: string;
    fullchainPem: string;
    privkeyPem: string;
    notAfter: number;
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
