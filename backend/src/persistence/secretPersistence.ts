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
    },
    { sequelize }
);

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
        await existing.update({ secretValue: sec.secretValue, secretPlaceholder: sec.secretPlaceholder, variable: sec.variable });
    } else {
        await SecretModel.create({ ...sec });
    }
};
