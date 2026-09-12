import { Op, OpType } from '@mosaiq/nsm-common/clusterOps';
import { Project } from '@mosaiq/nsm-common/types';
import { ProjectModelType, deleteProjectModel, updateProjectModelNoDirty, upsertProjectModel } from '@/persistence/projectPersistence';
import { deleteAllSecretsForProjectEnvModel, upsertSecretModel } from '@/persistence/secretPersistence';
import { deleteDesiredDeploymentModel, upsertDesiredDeploymentModel } from '@/persistence/desiredDeploymentPersistence';
import { setDesiredNsmVersion } from '@/persistence/clusterMetaPersistence';
import { createUserModel } from '@/persistence/userPersistence';
import { createAllowedEntityModel, deleteAllowedEntitiesModel, getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';

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
        default:
            console.warn('[stateMachine] unknown op', (op as any).type);
    }
};
