import { DataTypes, ModelAttributeColumnOptions } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0004-projects-add-cicd-column';

// The managed CI/CD snapshot column added to the projects table after it originally shipped.
// sequelize.sync() never adds columns to an existing table, so databases created before this column
// existed are missing it. The guard adds it only when absent, keeping this safe on fresh databases.
const COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    cicdConfigJson: { type: DataTypes.TEXT, allowNull: true },
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
