import { getProjectByIdModel, getAllProjectsModel } from '@/persistence/projectPersistence';
import { DeploymentState, Project, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { applyRepoData, getAllSecretsForProject } from './secretController';
import { getRepoData } from '@/utils/repositoryUtils';
import { getProjectInstancesByProjectIdModel } from '@/persistence/projectInstancePersistence';
import { teardownProject } from './deployController';
import { deleteProjectInstancesForProject } from './projectInstanceController';
import { cluster } from '@/cluster/node';

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
    return await syncProjectToRepoData(input.id);
};

export const updateProject = async (id: string, updates: Partial<Project>): Promise<void> => {
    const current = await getProject(id);
    if (!current) throw new Error('Project not found');
    const merged: Project = { ...current, ...updates, id, dirtyConfig: true };
    // secrets/instances are stored separately; do not let stale copies ride along.
    delete (merged as any).instances;
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
    const repoData = await getRepoData(project.id, project.repoOwner, project.repoName, project.repoBranch);
    if (!repoData) throw new Error('Failed to retrieve repository data');
    await applyRepoData(repoData, project.id);
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
    return newKey;
};

export const generate32CharKey = (): string => crypto.randomUUID().replace(/-/g, '');

export const setProjectAssignment = async (projectId: string, nodeId: string): Promise<void> => {
    await cluster.propose({ type: OpType.SET_PROJECT_ASSIGNMENT, projectId, nodeId });
};

export const deleteProject = async (projectId: string): Promise<boolean> => {
    try {
        await teardownProject(projectId);
        await deleteProjectInstancesForProject(projectId);
        await cluster.propose({ type: OpType.DELETE_PROJECT, projectId });
        return true;
    } catch (error) {
        console.error('Error deleting project:', error);
        return false;
    }
};
