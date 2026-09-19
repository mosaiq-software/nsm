import { sequelize } from '@/utils/dbHelper';
import { DomainRequest, DomainRequestStatus } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// Durable record of a domain purchase request. Non-super-admins create these; the super admin
// approves (buys) or denies. Applied via the state machine (UPSERT_DOMAIN_REQUEST).
class DomainRequestModel extends Model {}
DomainRequestModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        domainName: DataTypes.STRING,
        requesterId: DataTypes.STRING,
        requesterLogin: DataTypes.STRING,
        ownerId: DataTypes.STRING,
        ownerLogin: DataTypes.STRING,
        priceCurrency: DataTypes.STRING,
        priceRegistration: DataTypes.STRING,
        priceRenewal: DataTypes.STRING,
        status: DataTypes.STRING,
        decidedById: DataTypes.STRING,
        decidedByLogin: DataTypes.STRING,
        reason: DataTypes.TEXT,
        createdAt: DataTypes.NUMBER,
        updatedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const rowToRequest = (row: any): DomainRequest => ({
    id: row.id,
    domainName: row.domainName,
    requesterId: row.requesterId,
    requesterLogin: row.requesterLogin,
    ownerId: row.ownerId ?? undefined,
    ownerLogin: row.ownerLogin ?? undefined,
    priceCurrency: row.priceCurrency ?? undefined,
    priceRegistration: row.priceRegistration ?? undefined,
    priceRenewal: row.priceRenewal ?? undefined,
    status: row.status as DomainRequestStatus,
    decidedById: row.decidedById ?? undefined,
    decidedByLogin: row.decidedByLogin ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

export const upsertDomainRequestModel = async (request: DomainRequest): Promise<void> => {
    const existing = await DomainRequestModel.findByPk(request.id);
    if (existing) await existing.update({ ...request });
    else await DomainRequestModel.create({ ...request });
};

export const getDomainRequestModel = async (id: string): Promise<DomainRequest | null> => {
    const row = await DomainRequestModel.findByPk(id);
    return row ? rowToRequest(row.toJSON()) : null;
};

export const getAllDomainRequestsModel = async (): Promise<DomainRequest[]> => {
    return (await DomainRequestModel.findAll()).map((r) => rowToRequest(r.toJSON())).sort((a, b) => b.createdAt - a.createdAt);
};

export const getDomainRequestsByRequesterModel = async (requesterId: string): Promise<DomainRequest[]> => {
    return (await DomainRequestModel.findAll({ where: { requesterId } })).map((r) => rowToRequest(r.toJSON())).sort((a, b) => b.createdAt - a.createdAt);
};
