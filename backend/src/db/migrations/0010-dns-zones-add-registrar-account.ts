import { DataTypes } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0010-dns-zones-add-registrar-account';

// Zones are now keyed to a registrar account rather than being a single global Cloudflare mirror.
// sequelize.sync() never adds columns to an existing table, so databases created before this column
// existed need it added explicitly. New rows left null are adopted by the env->DB registrar
// migration (which assigns the pre-existing cache to the legacy account).
const TABLE = 'DnsZoneModels';
const COLUMN = 'registrarAccountId';

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const columns = await qi.describeTable(TABLE).catch(() => ({}) as Record<string, unknown>);
    if (!(columns as Record<string, unknown>)[COLUMN]) {
        await qi.addColumn(TABLE, COLUMN, { type: DataTypes.STRING, allowNull: true });
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    await qi.removeColumn(TABLE, COLUMN).catch(() => {});
};
