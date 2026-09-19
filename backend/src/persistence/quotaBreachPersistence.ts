import { sequelize } from '@/utils/dbHelper';
import { DataTypes, Model } from 'sequelize';

// Tracks the current resource-allocation breach state for a project so the quota checker can apply
// its notification cadence (notify on a newly-breached resource, then at most once per 24h while
// still over). A row exists only while a project is over at least one allocation; it is deleted when
// the project returns within all its allocations. `resourcesJson` is the sorted JSON array of the
// resource keys currently breached (e.g. ["cpu","storage"]); `lastNotifiedAt` is the epoch ms of
// the most recent notification.
class QuotaBreachStateModel extends Model {}
QuotaBreachStateModel.init(
    {
        projectId: { type: DataTypes.STRING, primaryKey: true },
        resourcesJson: DataTypes.TEXT,
        lastNotifiedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

export interface QuotaBreachState {
    projectId: string;
    resources: string[];
    lastNotifiedAt: number;
}

export const getQuotaBreachStateModel = async (projectId: string): Promise<QuotaBreachState | null> => {
    const row = await QuotaBreachStateModel.findByPk(projectId);
    if (!row) return null;
    const json = row.toJSON() as { projectId: string; resourcesJson: string; lastNotifiedAt: number };
    return {
        projectId: json.projectId,
        resources: json.resourcesJson ? JSON.parse(json.resourcesJson) : [],
        lastNotifiedAt: json.lastNotifiedAt ?? 0,
    };
};

export const setQuotaBreachStateModel = async (projectId: string, resources: string[], lastNotifiedAt: number): Promise<void> => {
    await QuotaBreachStateModel.upsert({ projectId, resourcesJson: JSON.stringify(resources), lastNotifiedAt });
};

export const clearQuotaBreachStateModel = async (projectId: string): Promise<void> => {
    await QuotaBreachStateModel.destroy({ where: { projectId } });
};
