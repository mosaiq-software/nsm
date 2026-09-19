import { Op, OpType } from '@mosaiq/nsm-common/clusterOps';
import { Project } from '@mosaiq/nsm-common/types';
import { ProjectModelType, deleteProjectModel, updateProjectModelNoDirty, upsertProjectModel } from '@/persistence/projectPersistence';
import { deleteAllSecretsForProjectEnvModel, upsertSecretModel } from '@/persistence/secretPersistence';
import { deleteDesiredDeploymentModel, upsertDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { setDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { createUserModel } from '@/persistence/userPersistence';
import { createAllowedEntityModel, deleteAllowedEntitiesModel, getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';
import { upsertTeamConfigModel } from '@/persistence/teamConfigPersistence';
import { deleteTeamOverrideModel, upsertTeamOverrideModel } from '@/persistence/teamOverridePersistence';
import { createAdminModel, deleteAdminModel } from '@/persistence/adminPersistence';
import { areaLog } from '@/utils/log';

const clusterLog = areaLog('cluster');

// Safe, secret-free summary of an op for the write log. Names/ids only - never secret values,
// tokens, dotenv, or auth material.
const opDetails = (op: Op): Record<string, unknown> => {
    switch (op.type) {
        case OpType.UPSERT_PROJECT:
            return { projectId: op.project.id, repoOwner: op.project.repoOwner, repoName: op.project.repoName, workerNodeId: op.project.workerNodeId };
        case OpType.DELETE_PROJECT:
        case OpType.CLEAR_DESIRED_DEPLOYMENT:
            return { projectId: op.projectId };
        case OpType.SET_PROJECT_SECRETS:
            return { projectId: op.projectId, secretCount: op.secrets.length };
        case OpType.UPSERT_SECRET:
            return { projectId: op.secret.projectId, secretName: op.secret.secretName };
        case OpType.SET_PROJECT_ASSIGNMENT:
            return { projectId: op.projectId, nodeId: op.nodeId };
        case OpType.SET_DESIRED_DEPLOYMENT:
            return { projectId: op.deployment.projectId, generation: op.deployment.generation, assignedNodeId: op.deployment.assignedNodeId, zeroDowntime: op.deployment.zeroDowntime };
        case OpType.SET_DESIRED_NSM_VERSION:
            return { version: op.version, artifactRef: op.artifactRef };
        case OpType.UPSERT_USER:
            return { githubId: op.user.githubId, name: op.user.name };
        case OpType.SET_ALLOWED_ENTITIES:
            return { entityCount: op.entities.length };
        case OpType.UPSERT_TEAM_CONFIG:
            return { ownerId: op.config.ownerId, login: op.config.login, capabilityCount: op.config.defaultCapabilities.length };
        case OpType.UPSERT_TEAM_OVERRIDE:
            return { ownerId: op.override.ownerId, memberLogin: op.override.memberLogin, capabilityCount: op.override.capabilities.length };
        case OpType.DELETE_TEAM_OVERRIDE:
            return { ownerId: op.ownerId, memberId: op.memberId };
        case OpType.ADD_ADMIN:
            return { id: op.admin.id, login: op.admin.login };
        case OpType.REMOVE_ADMIN:
            return { id: op.id };
        default:
            return {};
    }
};

const projectToRow = (p: Project): ProjectModelType => ({
    id: p.id,
    state: p.state as any,
    repoOwner: p.repoOwner,
    repoName: p.repoName,
    repoBranch: p.repoBranch,
    deploymentKey: p.deploymentKey || '',
    allowCICD: !!p.allowCICD,
    timeout: p.timeout,
    dirtyConfig: p.dirtyConfig,
    nginxConfigJson: JSON.stringify(p.nginxConfig || { servers: [] }),
    dockerComposeJson: JSON.stringify(p.dockerCompose || { services: {} }),
    servicesJson: JSON.stringify(p.services || []),
    workerNodeId: p.workerNodeId,
    hasDockerCompose: p.hasDockerCompose,
    hasDotenv: p.hasDotenv,
    zeroDowntime: p.zeroDowntime,
    cicdConfigJson: p.cicd ? JSON.stringify(p.cicd) : '',
    resourceQuotaJson: p.resourceQuota ? JSON.stringify(p.resourceQuota) : '',
});

// Deterministic, idempotent application of an op onto the leader's source-of-truth SQLite DB.
export const applyOp = async (op: Op): Promise<void> => {
    switch (op.type) {
        case OpType.UPSERT_PROJECT:
            await upsertProjectModel(projectToRow(op.project));
            break;
        case OpType.DELETE_PROJECT:
            await deleteProjectModel(op.projectId);
            await deleteDesiredDeploymentModel(op.projectId);
            break;
        case OpType.SET_PROJECT_SECRETS:
            await deleteAllSecretsForProjectEnvModel(op.projectId);
            for (const sec of op.secrets) await upsertSecretModel(sec);
            break;
        case OpType.UPSERT_SECRET:
            await upsertSecretModel(op.secret);
            break;
        case OpType.SET_PROJECT_ASSIGNMENT:
            await updateProjectModelNoDirty(op.projectId, { workerNodeId: op.nodeId });
            break;
        case OpType.SET_DESIRED_DEPLOYMENT:
            await upsertDesiredDeploymentModel(op.deployment);
            break;
        case OpType.CLEAR_DESIRED_DEPLOYMENT:
            await deleteDesiredDeploymentModel(op.projectId);
            break;
        case OpType.SET_DESIRED_NSM_VERSION:
            await setDesiredNsmVersion(op.version, op.artifactRef);
            break;
        case OpType.UPSERT_USER:
            await createUserModel(op.user);
            break;
        case OpType.SET_ALLOWED_ENTITIES: {
            const existing = await getAllAllowedEntitiesModel();
            for (const e of existing) await deleteAllowedEntitiesModel(e.id);
            for (const e of op.entities) await createAllowedEntityModel(e);
            break;
        }
        case OpType.UPSERT_TEAM_CONFIG:
            await upsertTeamConfigModel(op.config);
            break;
        case OpType.UPSERT_TEAM_OVERRIDE:
            await upsertTeamOverrideModel(op.override);
            break;
        case OpType.DELETE_TEAM_OVERRIDE:
            await deleteTeamOverrideModel(op.ownerId, op.memberId);
            break;
        case OpType.ADD_ADMIN:
            await createAdminModel(op.admin);
            break;
        case OpType.REMOVE_ADMIN:
            await deleteAdminModel(op.id);
            break;
        default:
            clusterLog.warn({ action: 'op_unknown', opType: (op as any).type }, 'unknown cluster op ignored');
            return;
    }
    clusterLog.info({ action: 'op_applied', opType: op.type, ...opDetails(op) }, `cluster op applied: ${op.type}`);
};
