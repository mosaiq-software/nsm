import { getAllSecretsForProjectModel } from '@/persistence/secretPersistence';
import { assembleDotenv, parseDotenv, parseDynamicVariablePath, extractSecretsFromDockerCompose, buildRawVarsIntoSecrets } from '@mosaiq/nsm-common/secretUtil';
import { DockerStatus, DynamicEnvVariableFields, FullDirectoryMap, NginxConfigLocationType, Project, ProjectService, RedirectConfigLocation, Secret } from '@mosaiq/nsm-common/types';
import { OpType, PortPlanEntry } from '@mosaiq/nsm-common/clusterOps';
import { getServicesForProject, RepoData } from '@/utils/repositoryUtils';
import { getProject, updateProject, updateProjectNoDirty } from './projectController';
import { cluster } from '@/cluster/node';

export const getDotenvForProject = async (project: Project, requestedPorts: PortPlanEntry[], dirMap: FullDirectoryMap): Promise<string> => {
    const secrets = (project.secrets || []).map((sec) => fillSecret(sec, project, requestedPorts, dirMap));
    return assembleDotenv(secrets);
};

export const getAllSecretsForProject = async (projectId: string): Promise<Secret[]> => {
    return await getAllSecretsForProjectModel(projectId);
};

export const applyRepoData = async (repoData: RepoData, projectId: string): Promise<void> => {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found when applying repo data');

    const envSecrets = parseDotenv(repoData.dotenv, projectId);
    const composeSecrets = extractSecretsFromDockerCompose(repoData.compose.contents, projectId);
    const jsSecrets = buildRawVarsIntoSecrets(repoData.jsEnvVars, projectId, 'JS Source Code');
    const combinedSecrets: Secret[] = [];
    const secretNames = new Set<string>();
    for (const sec of [...envSecrets, ...composeSecrets, ...jsSecrets]) {
        if (!secretNames.has(sec.secretName)) {
            combinedSecrets.push(sec);
            secretNames.add(sec.secretName);
        }
    }

    const oldProjectSecrets = await getAllSecretsForProjectModel(projectId);
    const updatedProjectSecrets: Secret[] = combinedSecrets.map((uSec) => {
        const currentSecret = oldProjectSecrets.find((sec) => sec.secretName === uSec.secretName);
        if (currentSecret) {
            return {
                projectId,
                secretName: currentSecret.secretName,
                secretValue: currentSecret.secretValue,
                variable: currentSecret.variable,
                secretPlaceholder: uSec.secretPlaceholder,
            };
        }
        return uSec;
    });

    await cluster.propose({ type: OpType.SET_PROJECT_SECRETS, projectId, secrets: updatedProjectSecrets });

    const newServices = getServicesForProject(repoData.compose.parsed);
    const oldServices = project.services || [];
    const updatedServices: ProjectService[] = newServices.map((sName) => {
        const old = oldServices.find((s) => s.serviceName === sName);
        if (old) return old;
        return { serviceName: sName, expectedContainerState: DockerStatus.UNKNOWN, collectContainerLogs: false };
    });

    await updateProjectNoDirty(projectId, {
        hasDockerCompose: repoData.compose.exists,
        hasDotenv: !!repoData.dotenv.trim().length,
        dockerCompose: repoData.compose.parsed,
        services: updatedServices,
    });
};

export const updateEnvironmentVariable = async (projectId: string, sec: Secret): Promise<void> => {
    await cluster.propose({ type: OpType.UPSERT_SECRET, secret: { ...sec, projectId } });
    await updateProject(projectId, {}); // flips dirtyConfig
};

const fillSecret = (secret: Secret, project: Project, requestedPorts: PortPlanEntry[], dirMap: FullDirectoryMap): Secret => {
    if (!secret.variable) return secret;
    try {
        const dynVarData = parseDynamicVariablePath(secret.secretValue);
        const server = project.nginxConfig?.servers.find((s) => s.serverId === dynVarData.serverId);
        const location = server?.locations.find((l) => l.locationId === dynVarData.locationId);
        switch (dynVarData.field) {
            case DynamicEnvVariableFields.WORKER_NODE_ID:
                return { ...secret, secretValue: project.workerNodeId || '' };
            case DynamicEnvVariableFields.DOMAIN:
                return { ...secret, secretValue: server?.domain || '' };
            case DynamicEnvVariableFields.URL:
                return { ...secret, secretValue: `https://${server?.domain || ''}${location?.path === '/' ? '' : location?.path}` };
            case DynamicEnvVariableFields.PATH:
                return { ...secret, secretValue: location?.path || '' };
            case DynamicEnvVariableFields.DIRECTORY:
                if (location?.type === NginxConfigLocationType.STATIC && dirMap[secret.secretValue]) return { ...secret, secretValue: dirMap[secret.secretValue].fullPath };
                return secret;
            case DynamicEnvVariableFields.PORT:
                if (location?.type === NginxConfigLocationType.PROXY) {
                    const req = requestedPorts.find((r) => r.proxyLocationId === location.locationId);
                    if (req) return { ...secret, secretValue: req.port.toString() };
                }
                return secret;
            case DynamicEnvVariableFields.TARGET:
                if (location?.type === NginxConfigLocationType.REDIRECT) return { ...secret, secretValue: (location as RedirectConfigLocation).target || '' };
                return secret;
            case DynamicEnvVariableFields.VOLUME:
                if (dirMap[secret.secretValue]) return { ...secret, secretValue: dirMap[secret.secretValue].fullPath };
                return secret;
            default:
                return secret;
        }
    } catch (error) {
        console.error(`Error parsing dynamic variable path: ${secret.secretValue}`, error);
        return secret;
    }
};
