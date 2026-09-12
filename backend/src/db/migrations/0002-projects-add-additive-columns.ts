import { DataTypes, ModelAttributeColumnOptions } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0002-projects-add-additive-columns';

// Columns added to the projects table over time. sequelize.sync() only creates missing tables - it
// never adds columns to an existing one - so databases created before a given column existed are
// missing it, and any query selecting it fails with "no such column". Each entry is added only when
// absent, which also keeps this safe on fresh databases where sync() already created every column.
const COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    timeout: { type: DataTypes.INTEGER, allowNull: true },
    dirtyConfig: { type: DataTypes.BOOLEAN, allowNull: true },
    workerNodeId: { type: DataTypes.STRING, allowNull: true },
    hasDockerCompose: { type: DataTypes.BOOLEAN, allowNull: true },
    hasDotenv: { type: DataTypes.BOOLEAN, allowNull: true },
    zeroDowntime: { type: DataTypes.BOOLEAN, allowNull: true },
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
