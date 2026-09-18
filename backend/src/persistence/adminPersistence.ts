import { sequelize } from '@/utils/dbHelper';
import { Admin } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// An NSM admin: an individual GitHub user with full access to everything except managing the admin
// list. The super admin (VITE_GITHUB_OAUTH_DEFAULT_USER) is implicit and is not stored here.
class AdminModel extends Model {}
AdminModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        login: DataTypes.STRING,
        avatarUrl: DataTypes.STRING,
    },
    { sequelize, timestamps: false }
);

export const createAdminModel = async (admin: Admin): Promise<void> => {
    const existing = await AdminModel.findOne({ where: { id: admin.id } });
    if (existing) {
        await existing.update({ ...admin });
        return;
    }
    await AdminModel.create({ ...admin });
};

export const deleteAdminModel = async (id: string): Promise<void> => {
    await AdminModel.destroy({ where: { id } });
};

export const getAllAdminsModel = async (): Promise<Admin[]> => {
    const rows = await AdminModel.findAll();
    return rows.map((r) => r.toJSON() as Admin);
};

export const getAdminByLoginModel = async (login: string): Promise<Admin | null> => {
    const rows = await AdminModel.findAll();
    const match = rows.map((r) => r.toJSON() as Admin).find((a) => a.login.toLowerCase() === login.toLowerCase());
    return match ?? null;
};
