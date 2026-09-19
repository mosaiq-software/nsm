import { describe, it, expect, beforeEach } from 'vitest';
import { sequelize } from '@/utils/dbHelper';
import '@/store/registerModels';
import { migrator } from '@/db/migrator';

// Start each test from freshly-synced tables and an empty migration ledger so every migration is
// pending (SequelizeMeta is not a registered model, so sync({ force: true }) leaves it untouched).
beforeEach(async () => {
    await sequelize.sync({ force: true });
    await sequelize.getQueryInterface().dropTable('SequelizeMeta').catch(() => {});
});

describe('migrator', () => {
    it('runs pending migrations, records them, and is idempotent', async () => {
        const first = await migrator.up();
        expect(first.map((m) => m.name)).toEqual(['0001-secrets-add-comment', '0002-projects-add-additive-columns', '0003-access-control-migrate-admins', '0004-projects-add-cicd-column', '0005-projects-add-resource-quota-column', '0006-service-instances-drop-collect-logs']);

        const executed = (await migrator.executed()).map((m) => m.name);
        expect(executed).toContain('0002-projects-add-additive-columns');

        const second = await migrator.up();
        expect(second).toHaveLength(0);
    });

    it('adds a column that is missing on a legacy table', async () => {
        const qi = sequelize.getQueryInterface();
        // Simulate a database created before the column existed.
        await qi.removeColumn('ProjectModels', 'zeroDowntime');
        expect((await qi.describeTable('ProjectModels')).zeroDowntime).toBeUndefined();

        await migrator.up();

        expect((await qi.describeTable('ProjectModels')).zeroDowntime).toBeDefined();
    });

    it('down() reverts the columns it added', async () => {
        const qi = sequelize.getQueryInterface();
        await migrator.up();
        await migrator.down({ to: 0 });
        const columns = await qi.describeTable('ProjectModels');
        expect(columns.zeroDowntime).toBeUndefined();
    });
});
