import { Admin } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { getAllAdminsModel } from '@/persistence/adminPersistence';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const adminLog = areaLog('admin');

export const getAdmins = async (): Promise<{ admins: Admin[]; superAdminLogin: string | null }> => {
    const admins = await getAllAdminsModel();
    const superAdminLogin = process.env.VITE_GITHUB_OAUTH_DEFAULT_USER || null;
    return { admins, superAdminLogin };
};

// Resolve a GitHub login to its numeric account id + avatar via the public API, then add as an admin.
export const addAdmin = async (login: string): Promise<Admin | null> => {
    const clean = login.trim();
    if (!clean) return null;
    let resolved: Admin;
    try {
        const res = await fetch(`https://api.github.com/users/${encodeURIComponent(clean)}`);
        if (!res.ok) return null;
        const data = (await res.json()) as { id: number; login: string; avatar_url: string; type: string };
        if (data.type !== 'User') return null; // admins are individual users only
        resolved = { id: String(data.id), login: data.login, avatarUrl: data.avatar_url };
    } catch {
        return null;
    }
    await cluster.propose({ type: OpType.ADD_ADMIN, admin: resolved });
    adminLog.info({ action: 'admin_added', id: resolved.id, login: resolved.login }, `added admin ${resolved.login}`);
    return resolved;
};

export const removeAdmin = async (id: string): Promise<void> => {
    await cluster.propose({ type: OpType.REMOVE_ADMIN, id });
    adminLog.info({ action: 'admin_removed', id }, `removed admin ${id}`);
};
