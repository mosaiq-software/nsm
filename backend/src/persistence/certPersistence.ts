import { sequelize } from '@/utils/dbHelper';
import { CertRecord } from '@mosaiq/nsm-common/clusterOps';
import { DataTypes, Model } from 'sequelize';

class CertModel extends Model {}
CertModel.init(
    {
        domain: { type: DataTypes.STRING, primaryKey: true },
        fullchainPem: DataTypes.TEXT,
        privkeyPem: DataTypes.TEXT,
        notAfter: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

export const upsertCertModel = async (cert: CertRecord): Promise<void> => {
    const existing = await CertModel.findByPk(cert.domain);
    if (existing) {
        await existing.update({ ...cert });
    } else {
        await CertModel.create({ ...cert });
    }
};

export const getCertModel = async (domain: string): Promise<CertRecord | null> => {
    return (await CertModel.findByPk(domain))?.toJSON() as CertRecord | null;
};

export const getAllCertsModel = async (): Promise<CertRecord[]> => {
    return (await CertModel.findAll())?.map((c) => c.toJSON()) as CertRecord[];
};

export const deleteCertModel = async (domain: string): Promise<void> => {
    await CertModel.destroy({ where: { domain } });
};
