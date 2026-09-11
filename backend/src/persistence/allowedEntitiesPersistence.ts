import { sequelize } from '@/utils/dbHelper';
import { AllowedEntityType, AllowedGithubEntity } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

class AllowedEntitiesModel extends Model {}
AllowedEntitiesModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        type: DataTypes.STRING,
        avatarUrl: DataTypes.STRING,
    },
    { sequelize, timestamps: false }
);

export const createAllowedEntityModel = async (entity: AllowedGithubEntity): Promise<void> => {
    await AllowedEntitiesModel.create({ ...entity });
};

export const deleteAllowedEntitiesModel = async (id: string): Promise<void> => {
    await AllowedEntitiesModel.destroy({ where: { id } });
};

export const getAllowedUsersModel = async (): Promise<AllowedGithubEntity[]> => {
    const users = await AllowedEntitiesModel.findAll({ where: { type: AllowedEntityType.USER } });
    return users.map((u) => u.toJSON() as AllowedGithubEntity);
};

export const getAllowedOrganizationsModel = async (): Promise<AllowedGithubEntity[]> => {
    const users = await AllowedEntitiesModel.findAll({ where: { type: AllowedEntityType.ORGANIZATION } });
    return users.map((u) => u.toJSON() as AllowedGithubEntity);
};

export const getAllAllowedEntitiesModel = async (): Promise<AllowedGithubEntity[]> => {
    const entities = await AllowedEntitiesModel.findAll();
    return entities.map((e) => e.toJSON() as AllowedGithubEntity);
};
