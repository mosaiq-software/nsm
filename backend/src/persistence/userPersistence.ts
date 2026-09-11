import { sequelize } from '@/utils/dbHelper';
import { User } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

class UserModel extends Model {}
UserModel.init(
    {
        githubId: { type: DataTypes.STRING, primaryKey: true },
        authToken: DataTypes.STRING,
        name: DataTypes.STRING,
        avatarUrl: DataTypes.STRING,
        created: DataTypes.NUMBER,
        signedIn: DataTypes.BOOLEAN,
    },
    { sequelize, timestamps: false }
);

export const createUserModel = async (user: User): Promise<void> => {
    const existingUser = await UserModel.findOne({ where: { githubId: user.githubId } });
    if (existingUser) {
        await existingUser.update({ ...user });
        return;
    }
    await UserModel.create({ ...user });
};

export const getUserByAuthTokenModel = async (authToken: string): Promise<User | null> => {
    const userInstance = await UserModel.findOne({ where: { authToken } });
    if (!userInstance) return null;
    return userInstance.toJSON() as User;
};

export const updateUserModel = async (user: Partial<User> & { githubId: string }): Promise<void> => {
    const existingUser = await UserModel.findOne({ where: { githubId: user.githubId } });
    if (!existingUser) throw new Error('User not found');
    await existingUser.update({ ...user });
};

export const getAllSignedInUsersModel = async (): Promise<User[]> => {
    const users = await UserModel.findAll({ where: { signedIn: true } });
    return users.map((u) => u.toJSON() as User);
};
