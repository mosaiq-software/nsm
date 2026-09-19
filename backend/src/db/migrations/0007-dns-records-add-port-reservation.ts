import { DataTypes, ModelAttributeColumnOptions } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0007-dns-records-add-port-reservation';

// Binds a cached DNS record to a port reservation whose port NSM writes into the record (e.g. SRV
// data.port). sequelize.sync() never adds columns to an existing table, so databases created before
// this column existed are missing it. The guard adds it only when absent, keeping this safe on
// fresh databases.
const COLUMNS: Record<string, ModelAttributeColumnOptions> = {
    portReservationId: { type: DataTypes.STRING, allowNull: true },
};

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'DnsRecordModels';
    const columns = await qi.describeTable(table);
    for (const [column, definition] of Object.entries(COLUMNS)) {
        if (!columns[column]) {
            await qi.addColumn(table, column, definition);
        }
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    const table = 'DnsRecordModels';
    for (const column of Object.keys(COLUMNS)) {
        await qi.removeColumn(table, column).catch(() => {});
    }
};
