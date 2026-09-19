import { getProjectByIdModel, getAllProjectsModel } from '@/persistence/projectPersistence';
import { DeploymentState, Project, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { applyLegacyOverlay, applyRepoData, getAllSecretsForProject } from './secretController';
import { getRepoData } from '@/utils/repositoryUtils';
import { getProjectInstancesByProjectIdModel } from '@/persistence/projectInstancePersistence';
import { purgeProjectOnAssignedNode, teardownProject, teardownProjectOnAssignedNode } from './deployController';
import { deleteProjectInstancesForProject } from './projectInstanceController';
import { renderAllNginx } from '@/reconcile/nginxRender';
import { removeCertsForDomains } from '@/reconcile/certs';
import { clearProjectHealth } from './healthController';
import { clearProjectIncidents } from './incidentController';
import { clearProjectApiKeys } from './apiKeyController';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';
import { putRepoSecret } from '@/utils/githubApp';

const projectLog = areaLog('project');

// === Reads: served from the local materialized view ===
export const getProject = async (projectId: string): Promise<Project | undefined> => {
    const projectData = await getProjectByIdModel(projectId);
    if (!projectData) return undefined;

    const secrets = await getAllSecretsForProject(projectId);
    const instances = (await getProjectInstancesByProjectIdModel(projectId)).sort((a, b) => b.created - a.created);
    const instanceHeaders: ProjectInstanceHeader[] = instances.map((inst) => ({
        id: inst.id,
        projectId: inst.projectId,
        workerNodeId: inst.workerNodeId,
        state: inst.state,
        created: inst.created,
        lastUpdated: inst.lastUpdated,
        active: inst.active,
        directories: inst.directories,
    }));

    return {
        id: projectData.id,
        repoOwner: projectData.repoOwner,
        repoName: projectData.repoName,
        repoBranch: projectData.repoBranch,
        deploymentKey: projectData.deploymentKey,
        state: projectData.state,
        createdAt: projectData.createdAt,
        updatedAt: projectData.updatedAt,
        secrets,
        instances: instanceHeaders,
        allowCICD: projectData.allowCICD,
        dirtyConfig: projectData.dirtyConfig,
        timeout: projectData.timeout,
        nginxConfig: JSON.parse(projectData.nginxConfigJson),
        dockerCompose: JSON.parse(projectData.dockerComposeJson),
        services: JSON.parse(projectData.servicesJson),
        workerNodeId: projectData.workerNodeId,
        hasDockerCompose: projectData.hasDockerCompose,
        hasDotenv: projectData.hasDotenv,
        zeroDowntime: projectData.zeroDowntime,
        cicd: projectData.cicdConfigJson ? JSON.parse(projectData.cicdConfigJson) : undefined,
        resourceQuota: projectData.resourceQuotaJson ? JSON.parse(projectData.resourceQuotaJson) : undefined,
    };
};

export const getAllProjects = async (): Promise<Project[]> => {
    const projectsData = await getAllProjectsModel();
    const projects: Project[] = [];
    for (const projectData of projectsData) projects.push((await getProject(projectData.id)) as Project);
    return projects;
};

// === Writes: applied on the leader's source-of-truth DB (routes forward followers to the leader) ===
export const proposeProjectUpsert = async (project: Project): Promise<void> => {
    await cluster.propose({ type: OpType.UPSERT_PROJECT, project });
};

export const createProject = async (input: Project): Promise<Project | undefined> => {
    const newProject: Project = {
        id: input.id,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        repoBranch: input.repoBranch,
        deploymentKey: generate32CharKey(),
        state: DeploymentState.READY,
        allowCICD: !!input.allowCICD,
        dirtyConfig: false,
        nginxConfig: { servers: [] },
        dockerCompose: { services: {} },
        services: [],
    };
    await proposeProjectUpsert(newProject);
    const synced = await syncProjectToRepoData(input.id);

    // Legacy import: overlay config downloaded from the old server-manager on top of the repo sync.
    const hasLegacy = !!(input.secrets?.length || input.nginxConfig?.servers?.length || input.services?.length || input.timeout != null);
    if (synced && hasLegacy) {
        await applyLegacyOverlay(input.id, input);
        return await getProject(input.id);
    }
    return synced;
};

export const updateProject = async (id: string, updates: Partial<Project>): Promise<void> => {
    const current = await getProject(id);
    if (!current) throw new Error('Project not found');
    const merged: Project = { ...current, ...updates, id, dirtyConfig: true };
    // secrets/instances are stored separately; do not let stale copies ride along.
    delete (merged as any).instances;
    // Resource allocation is admin-only and set via the dedicated quota endpoint; never let the
    // generic (CONFIGURE-gated) update route change it. Preserve the current value.
    merged.resourceQuota = current.resourceQuota;
    await proposeProjectUpsert(merged);
};

// Used internally by sync/secret application to update project without flipping dirtyConfig.
export const updateProjectNoDirty = async (id: string, updates: Partial<Project>): Promise<void> => {
    const current = await getProject(id);
    if (!current) throw new Error('Project not found');
    const merged: Project = { ...current, ...updates, id };
    delete (merged as any).instances;
    await proposeProjectUpsert(merged);
};

export const syncProjectToRepoData = async (projectId: string): Promise<Project | undefined> => {
    const project = await getProjectByIdModel(projectId);
    if (!project) throw new Error('Project not found');
    projectLog.info({ action: 'repo_sync_started', projectId, repoOwner: project.repoOwner, repoName: project.repoName, repoBranch: project.repoBranch }, `syncing ${projectId} from repo`);
    const repoData = await getRepoData(project.id, project.repoOwner, project.repoName, project.repoBranch);
    if (!repoData) throw new Error('Failed to retrieve repository data');
    await applyRepoData(repoData, project.id);
    projectLog.info({ action: 'repo_sync_completed', projectId }, `repo sync completed for ${projectId}`);
    return await getProject(projectId);
};

export const verifyDeploymentKey = async (projectId: string, key: string, fromWeb: boolean): Promise<boolean> => {
    const project = await getProjectByIdModel(projectId);
    if (!project) return false;
    if (!fromWeb && !project.allowCICD) return false;
    return project.deploymentKey === key;
};

export const resetDeploymentKey = async (projectId: string): Promise<string | null> => {
    const project = await getProject(projectId);
    if (!project) return null;
    const newKey = generate32CharKey();
    await updateProjectNoDirty(projectId, { deploymentKey: newKey });
    // Keep a managed CI/CD pipeline working by re-writing the repo secret with the new key.
    if (project.cicd?.managed) {
        try {
            await putRepoSecret(project.repoOwner, project.repoName, project.cicd.secretName, newKey);
        } catch (e: any) {
            projectLog.warn({ action: 'deployment_key_secret_update_failed', projectId, err: e?.message }, `failed to update CI/CD secret for ${projectId}`);
        }
    }
    projectLog.info({ action: 'deployment_key_reset', projectId }, `deployment key reset for ${projectId}`);
    return newKey;
};

export const generate32CharKey = (): string => crypto.randomUUID().replace(/-/g, '');

export const setProjectAssignment = async (projectId: string, nodeId: string): Promise<void> => {
    await cluster.propose({ type: OpType.SET_PROJECT_ASSIGNMENT, projectId, nodeId });
};

// Teardown (not deletion): take the project offline and clean up like a delete - remove the
// deployed code, nginx conf, and certs - but leave the persistent volume in place and keep the
// project (and its instance history) in the DB so it can be redeployed later.
export const teardownProjectWithCleanup = async (projectId: string): Promise<void> => {
    projectLog.info({ action: 'project_teardown_started', projectId }, `tearing down project ${projectId}`);
    const project = await getProject(projectId);
    const domains = (project?.nginxConfig?.servers || []).map((s) => s.domain).filter(Boolean);
    // Node-side teardown: containers + deploy dir removed, persistent dir left in place (no archive).
    if (project) await teardownProjectOnAssignedNode(project);
    await teardownProject(projectId);
    // Drop the project's nginx conf before removing its certs, so no conf references a deleted
    // fullchain.pem while nginx reloads.
    await renderAllNginx();
    await removeCertsForDomains(domains);
    projectLog.info({ action: 'project_torn_down', projectId }, `project ${projectId} torn down`);
};

export const deleteProject = async (projectId: string): Promise<boolean> => {
    try {
        projectLog.info({ action: 'project_delete_started', projectId }, `deleting project ${projectId}`);
        const project = await getProject(projectId);
        const domains = (project?.nginxConfig?.servers || []).map((s) => s.domain).filter(Boolean);
        // Node-side purge: containers + deploy dir removed, persistent dir archived (renamed).
        if (project) await purgeProjectOnAssignedNode(project);
        await teardownProject(projectId);
        await deleteProjectInstancesForProject(projectId);
        await clearProjectHealth(projectId);
        await clearProjectIncidents(projectId);
        await clearProjectApiKeys(projectId);
        await cluster.propose({ type: OpType.DELETE_PROJECT, projectId });
        // Drop the project's nginx conf before removing its certs, so no conf references a deleted
        // fullchain.pem while nginx reloads.
        await renderAllNginx();
        await removeCertsForDomains(domains);
        projectLog.info({ action: 'project_deleted', projectId }, `project ${projectId} deleted`);
        return true;
    } catch (error: any) {
        projectLog.error({ action: 'project_delete_failed', projectId, err: error?.message }, `failed to delete project ${projectId}`);
        return false;
    }
};
