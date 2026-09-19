import { DataTypes } from 'sequelize';
import { MigrationParams } from '../migrator';

export const name = '0006-service-instances-drop-collect-logs';

// The per-service `collectContainerLogs` flag never affected the log pipeline: the node agent ships
// every NSM-managed container's stdout/stderr to Loki regardless. The column is removed here so the
// dead setting no longer round-trips through the service instance table.
const TABLE = 'ServiceInstanceModels';
const COLUMN = 'collectContainerLogs';

export const up = async ({ context: qi }: MigrationParams): Promise<void> => {
    const columns = await qi.describeTable(TABLE);
    if (columns[COLUMN]) {
        await qi.removeColumn(TABLE, COLUMN);
    }
};

export const down = async ({ context: qi }: MigrationParams): Promise<void> => {
    const columns = await qi.describeTable(TABLE);
    if (!columns[COLUMN]) {
        await qi.addColumn(TABLE, COLUMN, { type: DataTypes.BOOLEAN, allowNull: true });
    }
};
