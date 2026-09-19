import { sequelize } from '@/utils/dbHelper';
import { Incident, IncidentImpact, IncidentKind, IncidentStatus, IncidentUpdate } from '@mosaiq/nsm-common/types';
import { DataTypes, Model } from 'sequelize';

// A project incident or scheduled maintenance. Durable, user-authored data replicated via cluster
// ops (like projects/secrets), so it survives and is served from the leader's source-of-truth DB.
class IncidentModel extends Model {}
IncidentModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        kind: DataTypes.STRING,
        title: DataTypes.TEXT,
        status: DataTypes.STRING,
        impact: DataTypes.STRING,
        startedAt: DataTypes.NUMBER,
        resolvedAt: DataTypes.NUMBER,
        scheduledStart: DataTypes.NUMBER,
        scheduledEnd: DataTypes.NUMBER,
        createdBy: DataTypes.STRING,
        createdAt: DataTypes.NUMBER,
        updatedAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

// One timeline entry on an incident.
class IncidentUpdateModel extends Model {}
IncidentUpdateModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        incidentId: DataTypes.STRING,
        status: DataTypes.STRING,
        body: DataTypes.TEXT,
        createdBy: DataTypes.STRING,
        createdAt: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false }
);

const toIncident = (row: any): Incident => ({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as IncidentKind,
    title: row.title,
    status: row.status as IncidentStatus,
    impact: row.impact as IncidentImpact,
    startedAt: row.startedAt,
    resolvedAt: row.resolvedAt ?? undefined,
    scheduledStart: row.scheduledStart ?? undefined,
    scheduledEnd: row.scheduledEnd ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const toUpdate = (row: any): IncidentUpdate => ({
    id: row.id,
    incidentId: row.incidentId,
    status: row.status as IncidentStatus,
    body: row.body,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
});

export const upsertIncidentModel = async (incident: Incident): Promise<void> => {
    const existing = await IncidentModel.findByPk(incident.id);
    if (existing) {
        await existing.update({ ...incident });
    } else {
        await IncidentModel.create({ ...incident });
    }
};

export const getIncidentByIdModel = async (id: string): Promise<Incident | null> => {
    const row = await IncidentModel.findByPk(id);
    return row ? toIncident(row.toJSON()) : null;
};

export const getIncidentsByProjectModel = async (projectId: string): Promise<Incident[]> => {
    const rows = await IncidentModel.findAll({ where: { projectId } });
    return rows.map((r) => toIncident(r.toJSON())).sort((a, b) => b.startedAt - a.startedAt);
};

export const deleteIncidentModel = async (id: string): Promise<void> => {
    await IncidentModel.destroy({ where: { id } });
    await IncidentUpdateModel.destroy({ where: { incidentId: id } });
};

export const deleteIncidentsForProjectModel = async (projectId: string): Promise<void> => {
    const incidents = await IncidentModel.findAll({ where: { projectId } });
    const ids = incidents.map((i) => (i.toJSON() as any).id as string);
    await IncidentModel.destroy({ where: { projectId } });
    for (const id of ids) await IncidentUpdateModel.destroy({ where: { incidentId: id } });
};

export const addIncidentUpdateModel = async (update: IncidentUpdate): Promise<void> => {
    const existing = await IncidentUpdateModel.findByPk(update.id);
    if (existing) {
        await existing.update({ ...update });
    } else {
        await IncidentUpdateModel.create({ ...update });
    }
};

export const getUpdatesByIncidentModel = async (incidentId: string): Promise<IncidentUpdate[]> => {
    const rows = await IncidentUpdateModel.findAll({ where: { incidentId } });
    return rows.map((r) => toUpdate(r.toJSON())).sort((a, b) => b.createdAt - a.createdAt);
};
