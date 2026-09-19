import { DataTypes, ModelAttributeColumnOptions } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0008-project-instances-add-deploy-timing';

// Per-deploy timing on project instances: when the build started (DEPLOYING) and how long it took to
// reach DEPLOYED. sequelize.sync() never adds columns to an existing table, so databases created
// before these columns existed are missing them. Each column is added only when absent, keeping this
// safe on fresh databases where sync() already created it.
const COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    deployStartedAt: { type: DataTypes.NUMBER, allowNull: true },
    deployDurationMs: { type: DataTypes.NUMBER, allowNull: true },
};

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'ProjectInstanceModels';
    const columns = await qi.describeTable(table);
    for (const [column, definition] of Object.entries(COLUMNS)) {
        if (!columns[column]) {
            await qi.addColumn(table, column, definition);
        }
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'ProjectInstanceModels';
    for (const column of Object.keys(COLUMNS)) {
        await qi.removeColumn(table, column).catch(() => {});
    }
};
