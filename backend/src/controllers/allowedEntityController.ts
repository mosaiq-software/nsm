import { getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';
import { AllowedGithubEntity } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { signOutAllUsers } from './userController';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const accessLog = areaLog('access');

export const setAllowedEntities = async (entities: AllowedGithubEntity[]): Promise<void> => {
    try {
        const allowed = await getAllAllowedEntitiesModel();
        const removedEntities = allowed.filter((a) => !entities.some((e) => e.id === a.id && e.type === a.type));
        await cluster.propose({ type: OpType.SET_ALLOWED_ENTITIES, entities });
        accessLog.info({ action: 'allowlist_updated', entityCount: entities.length, removedCount: removedEntities.length, removedIds: removedEntities.map((e) => e.id) }, `allowlist updated (${entities.length} entities)`);
        if (removedEntities.length > 0) {
            accessLog.info({ action: 'allowlist_removal_signout', removedCount: removedEntities.length }, 'signing out all users after allowlist removal');
            await signOutAllUsers();
        }
    } catch (error) {
        throw new Error('Failed to set allowed entities: ' + (error as Error).message);
    }
};

export const getAllowedEntities = async (): Promise<AllowedGithubEntity[]> => {
    try {
        const entities = await getAllAllowedEntitiesModel();
        return entities;
    } catch (error) {
        throw new Error('Failed to get allowed entities: ' + (error as Error).message);
    }
};
