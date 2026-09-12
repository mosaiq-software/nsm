import { sequelize } from '@/utils/dbHelper';
import { PushSubscriptionJSON } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// A stored Web Push subscription. Keyed by endpoint (the push service URL is globally unique per
// browser subscription) and tagged with the owning user's githubId so subscriptions can be pruned
// or targeted per user later.
export interface StoredPushSubscription extends PushSubscriptionJSON {
    githubId: string;
    created: number;
}

class PushSubscriptionModel extends Model {}
PushSubscriptionModel.init(
    {
        endpoint: { type: DataTypes.TEXT, primaryKey: true },
        githubId: DataTypes.STRING,
        p256dh: DataTypes.STRING,
        auth: DataTypes.STRING,
        created: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toSubscription = (row: any): StoredPushSubscription => ({
    endpoint: row.endpoint,
    githubId: row.githubId,
    created: row.created,
    keys: { p256dh: row.p256dh, auth: row.auth },
});

// Upsert a subscription. The same endpoint re-subscribing (e.g. a second sign-in) refreshes its
// keys and owner rather than creating a duplicate.
export const createPushSubscriptionModel = async (githubId: string, sub: PushSubscriptionJSON): Promise<void> => {
    await PushSubscriptionModel.upsert({
        endpoint: sub.endpoint,
        githubId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        created: Date.now(),
    });
};

export const getAllPushSubscriptionsModel = async (): Promise<StoredPushSubscription[]> => {
    const rows = await PushSubscriptionModel.findAll();
    return rows.map((r) => toSubscription(r.toJSON()));
};

export const deletePushSubscriptionByEndpointModel = async (endpoint: string): Promise<void> => {
    await PushSubscriptionModel.destroy({ where: { endpoint } });
};
