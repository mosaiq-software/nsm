import { getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';
import { AllowedGithubEntity } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { signOutAllUsers } from './userController';
import { cluster } from '@/cluster/node';

export const setAllowedEntities = async (entities: AllowedGithubEntity[]): Promise<void> => {
    try {
        const allowed = await getAllAllowedEntitiesModel();
        const removedEntities = allowed.filter((a) => !entities.some((e) => e.id === a.id && e.type === a.type));
        await cluster.propose({ type: OpType.SET_ALLOWED_ENTITIES, entities });
        if (removedEntities.length > 0) {
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
