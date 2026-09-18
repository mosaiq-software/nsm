import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// A per-user, per-project notification mute. Notifications are opt-out: absence of a row means the
// user receives that project's deploy notifications (subject to still having access). A row here
// suppresses them for that one project. Keyed by (githubId, projectId) using the stable GitHub
// account id so the preference survives across the user's browsers and sign-ins.
class NotificationMuteModel extends Model {}
NotificationMuteModel.init(
    {
        githubId: { type: DataTypes.STRING, primaryKey: true },
        projectId: { type: DataTypes.STRING, primaryKey: true },
        created: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

export const muteProjectModel = async (githubId: string, projectId: string): Promise<void> => {
    await NotificationMuteModel.upsert({ githubId, projectId, created: Date.now() });
};

export const unmuteProjectModel = async (githubId: string, projectId: string): Promise<void> => {
    await NotificationMuteModel.destroy({ where: { githubId, projectId } });
};

export const isProjectMutedModel = async (githubId: string, projectId: string): Promise<boolean> => {
    return (await NotificationMuteModel.count({ where: { githubId, projectId } })) > 0;
};

export const getMutedProjectIdsModel = async (githubId: string): Promise<string[]> => {
    const rows = await NotificationMuteModel.findAll({ where: { githubId } });
    return rows.map((r) => (r.toJSON() as { projectId: string }).projectId);
};

// The set of githubIds that have muted a given project, used to filter recipients when a deploy
// notification is dispatched.
export const getMutingGithubIdsForProjectModel = async (projectId: string): Promise<Set<string>> => {
    const rows = await NotificationMuteModel.findAll({ where: { projectId } });
    return new Set(rows.map((r) => (r.toJSON() as { githubId: string }).githubId));
};
