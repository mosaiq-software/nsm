import { DynamicEnvVariable, DynamicEnvVariableFields, DynamicEnvVariableType, NginxConfigLocationType, Project, Secret, UpperDynamicEnvVariableType } from './types';

export const assembleDotenv = (secrets: Secret[]): string => {
    return secrets.map((sec) => `${sec.secretName}=${sec.secretValue}`).join('\n');
};

export const parseDotenv = (dotenv: string, projectId: string): Secret[] => {
    const lines = dotenv.split('\n');
    const secrets: Secret[] = [];

    for (const _line of lines) {
        const line = _line.split('#')[0].trim();
        if (!line.length) continue;
        const [key, ...rest] = line.split('=');
        if (!key?.length) continue;
        if (key?.trim().length) {
            const value = rest.join('=');
            secrets.push({
                projectId: projectId,
                secretName: key.trim(),
                secretValue: '',
                secretPlaceholder: (value?.trim() ?? '').slice(0, 60) + (value && value.length > 60 ? '...' : '') + ' (from .env)',
                variable: false,
            });
        }
    }

    return secrets;
};

export const extractSecretsFromDockerCompose = (dockerCompose: string, projectId: string): Secret[] => {
    const vars = new Set<string>();
    const lines = dockerCompose.split('\n');
    for (const _line of lines) {
        const line = _line.split('#')[0].trim();
        if (!line.length) continue;
        const match = line.match(/\$\{([A-Za-z0-9_\-\.]+)\}/g);
        if (match) {
            for (const m of match) {
                const varName = m.slice(2, -1);
                vars.add(varName);
            }
        }
    }

    return buildRawVarsIntoSecrets(Array.from(vars), projectId, 'docker compose');
};

export const buildRawVarsIntoSecrets = (rawVars: string[], projectId: string, from: string): Secret[] => {
    const secrets: Secret[] = [];
    const seen = new Set<string>();

    for (const varName of rawVars) {
        if (seen.has(varName)) continue;
        seen.add(varName);
        secrets.push({
            projectId: projectId,
            secretName: varName,
            secretValue: '',
            secretPlaceholder: `(from ${from})`,
            variable: false,
        });
    }

    return secrets;
};

export const extractVariables = (project: Project) => {
    const { nginxConfig } = project;
    const vars = new Set<DynamicEnvVariable>();
    vars.add({ path: stringifyDynamicVariablePath(project.id, undefined, undefined, DynamicEnvVariableFields.WORKER_NODE_ID), placeholder: 'server-rig-1', type: UpperDynamicEnvVariableType.GENERAL });
    vars.add({ path: stringifyDynamicVariablePath(project.id, undefined, undefined, DynamicEnvVariableFields.VOLUME), placeholder: `/example-data/${project.id} (Generated on Deploy)`, type: UpperDynamicEnvVariableType.GENERAL });
    if (nginxConfig) {
        for (const server of nginxConfig.servers) {
            const serverId = `${project.id}.${server.serverId}`;
            vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, undefined, DynamicEnvVariableFields.DOMAIN), placeholder: server.domain, type: UpperDynamicEnvVariableType.DOMAIN });
            for (const location of server.locations) {
                const id = `${serverId}.${location.locationId}`;
                vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.URL), placeholder: `https://${server.domain}${location.path}`, type: location.type });
                vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.PATH), placeholder: location.path, type: location.type });
                switch (location.type) {
                    case NginxConfigLocationType.STATIC:
                        vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.DIRECTORY), placeholder: `/www/${project.id} (Generated on Deploy)`, type: location.type });
                        break;
                    case NginxConfigLocationType.PROXY:
                        vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.PORT), placeholder: '1234 (Generated on Deploy)', type: location.type });
                        break;
                    case NginxConfigLocationType.REDIRECT:
                        vars.add({ path: stringifyDynamicVariablePath(project.id, server.serverId, location.locationId, DynamicEnvVariableFields.TARGET), placeholder: location.target, type: location.type });
                        break;
                    case NginxConfigLocationType.CUSTOM:
                        break;
                }
            }
        }
    }
    return Array.from(vars);
};

export const stringifyDynamicVariablePath = (projectId: string, serverId: string | undefined, locationId: string | undefined, field: DynamicEnvVariableFields) => {
    return `${projectId}.${serverId || '_'}.${locationId || '_'}.${field}`;
};

export const parseDynamicVariablePath = (path: string): { projectId: string; serverId: string | undefined; locationId: string | undefined; field: DynamicEnvVariableFields } => {
    const [projectId, serverId, locationId, field] = path.split('.');
    if (!projectId || !serverId || !locationId || !field) {
        throw new Error(`Invalid dynamic variable path: ${path}`);
    }
    return { projectId, serverId: serverId === '_' ? undefined : serverId, locationId: locationId === '_' ? undefined : locationId, field: field as DynamicEnvVariableFields };
};
