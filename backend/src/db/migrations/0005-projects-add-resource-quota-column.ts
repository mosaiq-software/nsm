import { DataTypes, ModelAttributeColumnOptions } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0005-projects-add-resource-quota-column';

// The per-project resource allocation column added to the projects table after it originally
// shipped. sequelize.sync() never adds columns to an existing table, so databases created before
// this column existed are missing it. The guard adds it only when absent, keeping this safe on
// fresh databases.
const COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    resourceQuotaJson: { type: DataTypes.TEXT, allowNull: true },
};

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'ProjectModels';
    const columns = await qi.describeTable(table);
    for (const [column, definition] of Object.entries(COLUMNS)) {
        if (!columns[column]) {
            await qi.addColumn(table, column, definition);
        }
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'ProjectModels';
    for (const column of Object.keys(COLUMNS)) {
        await qi.removeColumn(table, column).catch(() => {});
    }
};
