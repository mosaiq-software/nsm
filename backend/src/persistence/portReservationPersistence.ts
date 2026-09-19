import { sequelize } from '@/utils/dbHelper';
import { PortProtocol, PortReservation } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// A fixed host port reserved on a node for one project (directly forwarded, not proxied). Leader-
// authoritative; written via cluster ops. Consumed at deploy time (env injection + proxy-port
// exclusion) and by DNS port bindings.
class PortReservationModel extends Model {}
PortReservationModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        nodeId: DataTypes.STRING,
        port: DataTypes.NUMBER,
        protocol: DataTypes.STRING,
        projectId: DataTypes.STRING,
        envVarName: DataTypes.STRING,
        label: DataTypes.STRING,
        created: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toReservation = (row: any): PortReservation => ({
    id: row.id,
    nodeId: row.nodeId,
    port: row.port,
    protocol: row.protocol as PortProtocol,
    projectId: row.projectId,
    envVarName: row.envVarName,
    label: row.label ?? undefined,
    created: row.created,
});

export const upsertPortReservationModel = async (reservation: PortReservation): Promise<void> => {
    const existing = await PortReservationModel.findByPk(reservation.id);
    if (existing) {
        await existing.update({ ...reservation });
    } else {
        await PortReservationModel.create({ ...reservation });
    }
};

export const getPortReservationByIdModel = async (id: string): Promise<PortReservation | null> => {
    const row = await PortReservationModel.findByPk(id);
    return row ? toReservation(row.toJSON()) : null;
};

export const getAllPortReservationsModel = async (): Promise<PortReservation[]> => {
    return (await PortReservationModel.findAll()).map((r) => toReservation(r.toJSON()));
};

export const getPortReservationsByNodeModel = async (nodeId: string): Promise<PortReservation[]> => {
    return (await PortReservationModel.findAll({ where: { nodeId } })).map((r) => toReservation(r.toJSON()));
};

export const getPortReservationsByProjectModel = async (projectId: string): Promise<PortReservation[]> => {
    return (await PortReservationModel.findAll({ where: { projectId } })).map((r) => toReservation(r.toJSON()));
};

export const getPortReservationsByNodeAndProjectModel = async (nodeId: string, projectId: string): Promise<PortReservation[]> => {
    return (await PortReservationModel.findAll({ where: { nodeId, projectId } })).map((r) => toReservation(r.toJSON()));
};

// All reserved port numbers on a node (both protocols), for exclusion from the dynamic proxy pool.
export const getReservedPortNumbersForNodeModel = async (nodeId: string): Promise<number[]> => {
    return (await PortReservationModel.findAll({ where: { nodeId } })).map((r) => (r.toJSON() as any).port as number);
};

export const deletePortReservationModel = async (id: string): Promise<void> => {
    await PortReservationModel.destroy({ where: { id } });
};

export const deletePortReservationsForProjectModel = async (projectId: string): Promise<void> => {
    await PortReservationModel.destroy({ where: { projectId } });
};

export const deletePortReservationsForNodeModel = async (nodeId: string): Promise<void> => {
    await PortReservationModel.destroy({ where: { nodeId } });
};
