import { getProjectByIdModel } from '@/persistence/projectPersistence';
import {
    DeploymentState,
    DockerStatus,
    DynamicEnvVariableFields,
    FullDirectoryMap,
    NginxConfigLocationType,
    Project,
    ProjectInstanceHeader,
    ProjectServiceInstance,
    ProxyConfigLocation,
    RelativeDirectoryMap,
    StaticConfigLocation,
} from '@mosaiq/nsm-common/types';
import { DesiredDeployment, OpType, PortPlanEntry } from '@mosaiq/nsm-common/clusterOps';
import { getDotenvForProject } from './secretController';
import { getProject, syncProjectToRepoData } from './projectController';
import { stringifyDynamicVariablePath } from '@mosaiq/nsm-common/secretUtil';
import { buildNginxConfigForProject } from '@/utils/nginxUtils';
import { appendToDeploymentLog, createProjectInstanceModel, getProjectInstanceByIdModel, getProjectInstancesByProjectIdModel, updateProjectInstanceModel } from '@/persistence/projectInstancePersistence';
import { DockerCompose } from '@mosaiq/nsm-common/dockerComposeTypes';
import { createServiceInstanceModel } from '@/persistence/serviceInstancePersistence';
import { buildDockerComposeString, sanitizeComposeForCoexistence } from '@/utils/repositoryUtils';
import { getDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { cluster } from '@/cluster/node';
import { postToNode } from '@/cluster/leaderClient';
import { getNextFreePorts } from '@/reconcile/ports';
import { ensureDirectories } from '@/reconcile/directories';
import { purgeProjectLocal } from '@/reconcile/teardown';
import { config } from '@/config';
import { DEFAULT_TIMEOUT, NSM_LABEL_SERVICE_INSTANCE_ID, NSM_LABEL_PROJECT_ID, NSM_LABEL_PROJECT_INSTANCE_ID, NSM_LABEL_SERVICE_NAME, NSM_LABEL_MANAGED } from '@/constants';
import { leaderEnsureCerts } from '@/reconcile/certs';
import { sendDeploymentNotification } from './pushController';

export { NSM_LABEL_SERVICE_INSTANCE_ID };

interface NodePlan {
    ports: number[] | null;
    dirs: FullDirectoryMap;
}

// Executed by a node when the leader asks it to allocate ports + ensure directories locally.
export const planLocally = async (proxyCount: number, dirs: RelativeDirectoryMap): Promise<NodePlan> => {
    const ports = proxyCount > 0 ? await getNextFreePorts(proxyCount) : [];
    const fullDirs = await ensureDirectories(dirs);
    return { ports, dirs: fullDirs };
};

const planOnAssignedNode = async (nodeId: string, proxyCount: number, dirs: RelativeDirectoryMap): Promise<NodePlan> => {
    if (nodeId === config.nodeId) return planLocally(proxyCount, dirs);
    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new Error(`Assigned node ${nodeId} not found in cluster`);
    const res = await postToNode<NodePlan>(node.address, node.apiPort, '/node/plan', { proxyCount, dirs });
    if (!res) throw new Error(`Failed to reach node ${nodeId} for deployment planning`);
    return res;
};

// Deletion-only: ask the project's assigned node to purge it (tear down containers + deploy dir,
// then archive the persistent dir). Best-effort - a missing/unreachable node never blocks deletion.
export const purgeProjectOnAssignedNode = async (project: Project): Promise<void> => {
    const nodeId = project.workerNodeId;
    if (!nodeId) return;
    if (nodeId === config.nodeId) {
        await purgeProjectLocal(project.id);
        return;
    }
    const node = await getNodeByIdModel(nodeId);
    if (!node) return;
    await postToNode(node.address, node.apiPort, '/node/purge-project', { projectId: project.id });
};

// Leader-only: render a project into a self-contained DesiredDeployment and replicate it.
// When `existingInstanceId` is passed (by the deploy queue), that already-created ProjectInstance is
// transitioned from QUEUED to DEPLOYING and reused as the log target, rather than creating a new one.
export const deployProject = async (projectId: string, existingInstanceId?: string): Promise<string | undefined> => {
    if (!cluster.isLeader()) throw new Error('deployProject must run on the leader');
    let instanceId: string | undefined = existingInstanceId;
    try {
        let project = await getProject(projectId);
        if (!project) throw new Error('Project not found');
        if (!project.repoOwner || !project.repoName) throw new Error('Project repository information incomplete');
        if (!project.workerNodeId) throw new Error('No node assigned to project');

        const assignedNode = await getNodeByIdModel(project.workerNodeId);
        if (!assignedNode) throw new Error('Assigned node not found in cluster');

        if (existingInstanceId) {
            instanceId = existingInstanceId;
            await updateProjectInstanceModel(instanceId, { state: DeploymentState.DEPLOYING, workerNodeId: project.workerNodeId });
        } else {
            instanceId = crypto.randomUUID();
            const projectInstanceHeader: ProjectInstanceHeader = {
                id: instanceId,
                projectId,
                workerNodeId: project.workerNodeId,
                state: DeploymentState.DEPLOYING,
                created: Date.now(),
                lastUpdated: Date.now(),
                active: true,
                directories: {},
            };
            await createProjectInstanceModel(projectInstanceHeader);
        }

        const beforeSync = JSON.stringify(project);
        await syncProjectToRepoData(projectId);
        project = await getProject(projectId);
        if (!project) throw new Error('Project not found after sync');
        if (!compareProjects(JSON.parse(beforeSync), project)) {
            throw new Error('Project configuration changed after syncing with repository. Review and try again.');
        }
        if (!project.hasDockerCompose) throw new Error('Project does not have a Docker Compose file in the repository root');
        if (!project.workerNodeId) throw new Error('No node assigned to project');

        const zeroDowntime = effectiveZeroDowntime(project);

        // Ask the assigned node to allocate ports + ensure directories.
        const proxyCount = countProxies(project);
        const dirRequest = buildDirectoryRequest(project);
        const plan = await planOnAssignedNode(project.workerNodeId, proxyCount, dirRequest);
        const requestedPorts = mapPorts(project, plan.ports);
        await updateProjectInstanceModel(instanceId, { directories: plan.dirs });

        const dotenv = await getDotenvForProject(project, requestedPorts, plan.dirs);
        const { conf: nginxConf, domains } = getNginxConf(project, requestedPorts, plan.dirs, project.workerNodeId);

        // Service instances (observability) + inject service-instance labels into compose.
        const serviceNameToInstanceId: { [serviceName: string]: string } = {};
        const serviceInstances: ProjectServiceInstance[] = [];
        for (const service of project.services || []) {
            const instance: ProjectServiceInstance = {
                instanceId: crypto.randomUUID(),
                projectInstanceId: instanceId,
                containerId: undefined,
                actualContainerState: DockerStatus.UNKNOWN,
                containerLogs: '',
                created: Date.now(),
                lastUpdated: Date.now(),
                serviceName: service.serviceName,
                expectedContainerState: service.expectedContainerState,
                collectContainerLogs: service.collectContainerLogs,
            };
            serviceNameToInstanceId[service.serviceName] = instance.instanceId;
            serviceInstances.push(instance);
            await createServiceInstanceModel(instance);
        }

        const compose: DockerCompose = project.dockerCompose || { services: {} };
        for (const svc in compose.services) {
            const rawLabels = compose.services[svc].labels;
            let labels: DockerCompose['services'][number]['labels'] = {};
            if (Array.isArray(rawLabels)) {
                for (const label of rawLabels) {
                    const [key, ...rest] = label.split('=');
                    labels[key] = rest.join('=');
                }
            } else if (rawLabels) {
                labels = rawLabels;
            }
            // Deployment-scoped labels so log/metric agents can tag telemetry per deployment.
            labels[NSM_LABEL_SERVICE_INSTANCE_ID] = serviceNameToInstanceId[svc];
            labels[NSM_LABEL_PROJECT_ID] = project.id;
            labels[NSM_LABEL_PROJECT_INSTANCE_ID] = instanceId!;
            labels[NSM_LABEL_SERVICE_NAME] = svc;
            labels[NSM_LABEL_MANAGED] = 'true';
            compose.services[svc].labels = labels;
        }

        // For zero-downtime the two generations coexist, so strip compose footguns that collide
        // (hardcoded container_name / fixed host ports) and warn about named volumes.
        if (zeroDowntime) {
            const { warnings } = sanitizeComposeForCoexistence(compose);
            for (const w of warnings) await updateDeploymentLog(instanceId!, DeploymentState.DEPLOYING, `[zero-downtime] ${w}\n`);
        }
        const composeString = buildDockerComposeString(compose);

        const prev = await getDesiredDeploymentModel(projectId);
        const generation = (prev?.generation ?? 0) + 1;
        const deployment: DesiredDeployment = {
            projectId: project.id,
            generation,
            assignedNodeId: project.workerNodeId,
            repoOwner: project.repoOwner,
            repoName: project.repoName,
            repoBranch: project.repoBranch,
            timeout: project.timeout || DEFAULT_TIMEOUT,
            logId: instanceId!,
            dotenv,
            compose: composeString,
            nginxConf,
            domains,
            services: serviceInstances,
            zeroDowntime,
            ports: requestedPorts,
            // Zero-downtime keeps serving the previously-active generation until the node reports the
            // new one ready (promoteDeployment flips it). The legacy path cuts over immediately.
            activeGeneration: zeroDowntime ? prev?.activeGeneration : generation,
            activeNginxConf: zeroDowntime ? prev?.activeNginxConf : nginxConf,
            activeDomains: zeroDowntime ? prev?.activeDomains : domains,
        };
        await cluster.propose({ type: OpType.SET_DESIRED_DEPLOYMENT, deployment });
        // Kick off cert issuance for any new domains (leader-side, best effort).
        void leaderEnsureCerts();
    } catch (error: any) {
        console.error('Error deploying project:', error);
        if (instanceId) await updateDeploymentLog(instanceId, DeploymentState.FAILED, `Error deploying project: ${error.message}\n`);
    }
    return instanceId;
};

const TERMINAL_DEPLOY_STATES = [DeploymentState.DEPLOYED, DeploymentState.HEALTHY, DeploymentState.FAILED];

export const updateDeploymentLog = async (instanceId: string, status: DeploymentState, logText: string) => {
    // Read the prior state first so we can fire a push notification only on the transition into a
    // terminal state (updateDeploymentLog is called repeatedly with the same state as logs append).
    const prev = await getProjectInstanceByIdModel(instanceId);
    await updateProjectInstanceModel(instanceId, { state: status });
    await appendToDeploymentLog(instanceId, logText);
    if (TERMINAL_DEPLOY_STATES.includes(status) && prev && prev.state !== status) {
        try {
            const project = await getProject(prev.projectId);
            if (project) void sendDeploymentNotification(project, status);
        } catch (e) {
            console.error('[push] deployment notification failed', e);
        }
    }
};

// Effective zero-downtime for a project: on by default (node-wide config), unless this node has it
// turned off globally or the project explicitly opted out.
const effectiveZeroDowntime = (project: Project): boolean => config.zeroDowntime && project.zeroDowntime !== false;

// Leader-only: a node has reported its new (blue) generation ready. Promote it so nginx renders the
// new ports on the next reconcile, and deactivate the superseded ProjectInstances. Idempotent and
// safe against stale reports (a ready for an already-superseded generation is ignored).
export const promoteDeployment = async (projectId: string, generation: number, _nodeId: string): Promise<void> => {
    if (!cluster.isLeader()) return;
    const dep = await getDesiredDeploymentModel(projectId);
    if (!dep) return;
    if (dep.generation !== generation) return; // stale: a newer generation has already superseded this
    if (dep.activeGeneration !== generation) {
        const promoted: DesiredDeployment = { ...dep, activeGeneration: generation, activeNginxConf: dep.nginxConf, activeDomains: dep.domains };
        await cluster.propose({ type: OpType.SET_DESIRED_DEPLOYMENT, deployment: promoted });
    }
    // The just-promoted generation's instance is dep.logId; deactivate any older active instances so
    // the UI/observability show a single active deployment.
    const instances = await getProjectInstancesByProjectIdModel(projectId);
    for (const inst of instances) {
        if (inst.active && inst.id !== dep.logId) await updateProjectInstanceModel(inst.id, { active: false });
    }
    // New domains may now be served; make sure their certs exist (best effort).
    void leaderEnsureCerts();
};

const countProxies = (project: Project): number => {
    let n = 0;
    for (const server of project.nginxConfig?.servers || []) for (const loc of server.locations) if (loc.type === NginxConfigLocationType.PROXY) n++;
    return n;
};

const buildDirectoryRequest = (project: Project): RelativeDirectoryMap => {
    const dirs: RelativeDirectoryMap = {};
    dirs[stringifyDynamicVariablePath(project.id, undefined, undefined, DynamicEnvVariableFields.VOLUME)] = { relPath: `/${project.id}/volume` };
    for (const server of project.nginxConfig?.servers || []) {
        for (const location of server.locations) {
            if (location.type === NginxConfigLocationType.STATIC) {
                dirs[stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.DIRECTORY)] = { relPath: `/${project.id}/www/${server.serverId}/${location.locationId}`, base: 'deploy' };
            }
        }
    }
    return dirs;
};

const mapPorts = (project: Project, ports: number[] | null): PortPlanEntry[] => {
    const proxies: ProxyConfigLocation[] = [];
    for (const server of project.nginxConfig?.servers || []) for (const loc of server.locations) if (loc.type === NginxConfigLocationType.PROXY) proxies.push(loc);
    if (!proxies.length) return [];
    if (!ports || ports.length < proxies.length) throw new Error('Not enough free ports on the assigned node');
    return proxies.map((p, i) => ({ proxyLocationId: p.locationId, port: ports[i], readinessPath: p.readinessPath }));
};

// Note: the proxy target is the assigned node's STABLE internal hostname (<nodeId>.<domain>),
// never a raw IP. The leader keeps /etc/hosts mapping that hostname to the node's current IP, so
// an IP change never rewrites this conf - only refreshes the mapping + reloads nginx.
const getNginxConf = (project: Project, requestedPorts: PortPlanEntry[], ensuredDirs: FullDirectoryMap, assignedNodeId: string): { conf: string; domains: string[] } => {
    const domains: string[] = [];
    const projectDC = JSON.parse(JSON.stringify(project)) as Project;
    for (const server of projectDC.nginxConfig?.servers || []) {
        domains.push(server.domain);
        for (const location of server.locations) {
            if (location.type === NginxConfigLocationType.PROXY) {
                const req = requestedPorts.find((r) => r.proxyLocationId === location.locationId);
                if (req) (location as ProxyConfigLocation).proxyPass = `http://${assignedNodeId}.${config.internalDomain}:${req.port}`;
            }
            if (location.type === NginxConfigLocationType.STATIC) {
                const dirVar = stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.DIRECTORY);
                if (ensuredDirs[dirVar]) (location as StaticConfigLocation).serveDir = ensuredDirs[dirVar].fullPath;
            }
        }
    }
    return { conf: buildNginxConfigForProject(projectDC), domains };
};

const compareProjects = (projA: Project, projB: Project): boolean => {
    if (JSON.stringify(projA.nginxConfig || { servers: [] }) !== JSON.stringify(projB.nginxConfig || { servers: [] })) return false;
    const secretsA = projA.secrets?.map((s) => s.secretName).sort().join(',');
    const secretsB = projB.secrets?.map((s) => s.secretName).sort().join(',');
    if (secretsA !== secretsB) return false;
    if (JSON.stringify(projA.services || []) !== JSON.stringify(projB.services || [])) return false;
    return projA.repoOwner === projB.repoOwner && projA.repoName === projB.repoName && projA.repoBranch === projB.repoBranch && projA.hasDockerCompose === projB.hasDockerCompose && projA.hasDotenv === projB.hasDotenv;
};

// Teardown intent: clear desired deployment so the owning node's reconciler removes it.
export const teardownProject = async (projectId: string): Promise<void> => {
    if (!cluster.isLeader()) throw new Error('teardownProject must run on the leader');
    const project = await getProjectByIdModel(projectId);
    if (!project) return;
    const instances = await getProjectInstancesByProjectIdModel(projectId);
    for (const inst of instances) {
        if (inst.active) await updateProjectInstanceModel(inst.id, { state: DeploymentState.DESTROYING, active: false });
    }
    await cluster.propose({ type: OpType.CLEAR_DESIRED_DEPLOYMENT, projectId });
};
