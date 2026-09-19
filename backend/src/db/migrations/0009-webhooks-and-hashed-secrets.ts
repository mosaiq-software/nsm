import { DataTypes, ModelAttributeColumnOptions, QueryTypes } from 'sequelize';
import { MigrationParams } from '../migrator';
import { sha256Hex } from '@/utils/hash';

export const name = '0009-webhooks-and-hashed-secrets';

// Columns for the shared GitHub webhook + hashed deploy key (projects) and GitHub notification
// scenarios (project webhooks). sequelize.sync() never adds columns to an existing table, so these
// are added only when absent, keeping this safe on fresh databases. The deploy key is migrated from
// plaintext to a SHA-256 hash and the plaintext is cleared.
const PROJECT_COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    deploymentKeyHash: { type: DataTypes.STRING, allowNull: true },
    githubWebhookJson: { type: DataTypes.TEXT, allowNull: true },
};

const WEBHOOK_COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    githubScenariosJson: { type: DataTypes.TEXT, allowNull: true },
};

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const projectColumns = await qi.describeTable('ProjectModels');
    for (const [column, definition] of Object.entries(PROJECT_COLUMNS)) {
        if (!projectColumns[column]) await qi.addColumn('ProjectModels', column, definition);
    }

    // Backfill deploymentKeyHash from any pre-existing plaintext deploymentKey, then clear plaintext.
    if (projectColumns.deploymentKey) {
        const rows = await qi.sequelize.query<{ id: string; deploymentKey: string | null }>('SELECT id, deploymentKey FROM ProjectModels', { type: QueryTypes.SELECT });
        for (const row of rows) {
            if (!row.deploymentKey) continue;
            await qi.sequelize.query('UPDATE ProjectModels SET deploymentKeyHash = :hash, deploymentKey = :empty WHERE id = :id', {
                replacements: { hash: sha256Hex(row.deploymentKey), empty: '', id: row.id },
            });
        }
    }

    const webhookColumns = await qi.describeTable('ProjectWebhookModels');
    for (const [column, definition] of Object.entries(WEBHOOK_COLUMNS)) {
        if (!webhookColumns[column]) await qi.addColumn('ProjectWebhookModels', column, definition);
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    for (const column of Object.keys(PROJECT_COLUMNS)) {
        await qi.removeColumn('ProjectModels', column).catch(() => {});
    }
    for (const column of Object.keys(WEBHOOK_COLUMNS)) {
        await qi.removeColumn('ProjectWebhookModels', column).catch(() => {});
    }
};
