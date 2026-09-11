import { sequelize } from '@/utils/dbHelper';
import { Secret } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

class SecretModel extends Model {}
SecretModel.init(
    {
        projectId: {
            type: DataTypes.STRING,
            primaryKey: true,
        },
        secretName: {
            type: DataTypes.STRING,
            primaryKey: true,
        },
        secretValue: {
            type: DataTypes.STRING,
        },
        secretPlaceholder: {
            type: DataTypes.STRING,
        },
        variable: DataTypes.BOOLEAN,
        comment: {
            type: DataTypes.STRING,
            allowNull: true,
        },
    },
    { sequelize }
);

// Additively add the `comment` column to an existing secrets table via a native ADD COLUMN.
// We deliberately avoid Sequelize's `sync({ alter: true })`: on SQLite it rebuilds the table, which
// mishandles this model's composite primary key (projectId + secretName) and fails with a spurious
// UNIQUE violation. Never throws, so a schema hiccup can't crash-loop the daemon on startup.
export const ensureSecretSchema = async (): Promise<void> => {
    try {
        const qi = sequelize.getQueryInterface();
        const tableName = SecretModel.getTableName() as string;
        // Drop any leftover `*_backup` table from a previously failed Sequelize alter attempt.
        await qi.dropTable(`${tableName}_backup`).catch(() => {});
        const columns = await qi.describeTable(tableName);
        if (!columns.comment) {
            await qi.addColumn(tableName, 'comment', { type: DataTypes.STRING, allowNull: true });
        }
    } catch (e) {
        console.error('ensureSecretSchema: could not ensure the secrets.comment column exists', e);
    }
};

export const getAllSecretsForProjectModel = async (projectId: string): Promise<Secret[]> => {
    return (await SecretModel.findAll({ where: { projectId } }))?.map((sec) => sec.toJSON()) as Secret[];
};

export const createSecretModel = async (sec: Secret) => {
    return await SecretModel.create({ ...sec });
};

export const updateSecretModel = async (projectId: string, secret: Secret) => {
    return await SecretModel.update(
        {
            secretValue: secret.secretValue,
            secretPlaceholder: secret.secretPlaceholder,
            variable: secret.variable,
            comment: secret.comment ?? null,
        },
        { where: { projectId, secretName: secret.secretName } }
    );
};

export const deleteAllSecretsForProjectEnvModel = async (projectId: string) => {
    return await SecretModel.destroy({ where: { projectId } });
};

export const upsertSecretModel = async (sec: Secret) => {
    const existing = await SecretModel.findOne({ where: { projectId: sec.projectId, secretName: sec.secretName } });
    if (existing) {
        await existing.update({ secretValue: sec.secretValue, secretPlaceholder: sec.secretPlaceholder, variable: sec.variable, comment: sec.comment ?? null });
    } else {
        await SecretModel.create({ ...sec });
    }
};
