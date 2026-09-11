import { DynamicEnvVariable, DynamicEnvVariableFields, DynamicEnvVariableType, NginxConfigLocationType, Project, Secret, UpperDynamicEnvVariableType } from './types';

export const assembleDotenv = (secrets: Secret[]): string => {
    return secrets.map((sec) => `${sec.secretName}=${sec.secretValue}`).join('\n');
};

// Strip a leading run of `#` and one optional space from a comment line: "## note" -> "note".
const stripCommentMarker = (line: string): string => line.replace(/^#+\s?/, '').trim();

export const parseDotenv = (dotenv: string, projectId: string): Secret[] => {
    const lines = dotenv.split('\n');
    const secrets: Secret[] = [];
    // Comment lines directly above the current variable, reset on a blank line or after a variable.
    let pendingComments: string[] = [];

    for (const _line of lines) {
        const trimmed = _line.trim();

        // A blank line breaks the run of comments attached to the next variable.
        if (!trimmed.length) {
            pendingComments = [];
            continue;
        }

        // A full-line comment: accumulate it as description for the next variable.
        if (trimmed.startsWith('#')) {
            const text = stripCommentMarker(trimmed);
            if (text.length) pendingComments.push(text);
            continue;
        }

        // A variable line. Split off an inline trailing comment (everything after the first `#`).
        const hashIndex = _line.indexOf('#');
        const inlineComment = hashIndex >= 0 ? _line.slice(hashIndex + 1).trim() : '';
        const assignment = (hashIndex >= 0 ? _line.slice(0, hashIndex) : _line).trim();
        if (!assignment.length) {
            pendingComments = [];
            continue;
        }
        const [key, ...rest] = assignment.split('=');
        if (!key?.trim().length) {
            pendingComments = [];
            continue;
        }
        const value = rest.join('=');
        // Subtitle: the N comment lines above, then the inline trailing comment at the end.
        const commentParts = [...pendingComments];
        if (inlineComment.length) commentParts.push(inlineComment);
        secrets.push({
            projectId: projectId,
            secretName: key.trim(),
            secretValue: '',
            secretPlaceholder: (value?.trim() ?? '').slice(0, 60) + (value && value.length > 60 ? '...' : '') + ' (from .env)',
            variable: false,
            comment: commentParts.length ? commentParts.join('\n') : undefined,
        });
        pendingComments = [];
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
