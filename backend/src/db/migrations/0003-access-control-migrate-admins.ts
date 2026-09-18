import { MigrationParams } from '../migrator';
import { AllowedEntityType } from '@mosaiq/nsm-common/types';
import { getAllAllowedEntitiesModel } from '@/persistence/allowedEntitiesPersistence';
import { createAdminModel, getAllAdminsModel } from '@/persistence/adminPersistence';

export const name = '0003-access-control-migrate-admins';

// The old allowlist granted site-wide access to individual users and whole orgs. Under the new model
// individual allowed users become NSM admins; allowed orgs are obsolete (teams are now discovered
// from GitHub App installations) and are intentionally not carried over. The new tables themselves
// are created by sequelize.sync() before migrations run; this migration only moves the data. It runs
// once and is a no-op if the admin table is already populated.
export const up = async (_params: MigrationParams): Promise<void> => {
    const existingAdmins = await getAllAdminsModel();
    if (existingAdmins.length > 0) return;
    let entities;
    try {
        entities = await getAllAllowedEntitiesModel();
    } catch {
        // No legacy allowlist table (fresh database) - nothing to migrate.
        return;
    }
    for (const entity of entities) {
        if (entity.type !== AllowedEntityType.USER) continue;
        // Legacy allowlist stored the GitHub login as `id` and has no numeric account id; use the
        // login as the stable key (admin checks match by login). Re-adding via the UI later resolves
        // the real account id.
        await createAdminModel({ id: entity.id.toLowerCase(), login: entity.id, avatarUrl: entity.avatarUrl || '' });
    }
};

export const down = async (_params: MigrationParams): Promise<void> => {
    // Non-reversible data migration; leave admins in place.
};
