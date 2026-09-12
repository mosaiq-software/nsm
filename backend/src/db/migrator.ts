import { QueryInterface } from 'sequelize';
import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize } from '@/utils/dbHelper';
import { migrations } from './migrations';

// Each migration receives the shared QueryInterface as its `context`.
export interface MigrationParams {
    context: QueryInterface;
}

// Programmatic migration runner. Sequelize's own docs point to umzug for running migrations in
// code (there is no CLI step in the daemon's self-update flow, which just checks out the new
// commit and restarts). Applied migrations are tracked in the `SequelizeMeta` table so each one
// runs exactly once per database.
export const migrator = new Umzug({
    migrations,
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
});

export const runMigrations = async (): Promise<void> => {
    await migrator.up();
};
