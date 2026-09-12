import { DataTypes } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0001-secrets-add-comment';

// The `comment` column was added to the secrets table after it originally shipped. The guard keeps
// this safe on databases where sequelize.sync() already created the table with the column present.
export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'SecretModels';
    // Remove any leftover `*_backup` table from a previously failed Sequelize alter attempt.
    await qi.dropTable(`${table}_backup`).catch(() => {});
    const columns = await qi.describeTable(table);
    if (!columns.comment) {
        await qi.addColumn(table, 'comment', { type: DataTypes.STRING, allowNull: true });
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    await qi.removeColumn('SecretModels', 'comment');
};
