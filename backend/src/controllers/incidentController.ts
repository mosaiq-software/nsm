import crypto from 'crypto';
import { AddIncidentUpdateBody, CreateIncidentBody, Incident, IncidentKind, IncidentStatus, IncidentUpdate, IncidentWithUpdates, UpdateIncidentBody } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { addIncidentUpdateModel, deleteIncidentsForProjectModel, getIncidentByIdModel, getIncidentsByProjectModel, getUpdatesByIncidentModel } from '@/persistence/incidentPersistence';
import { cluster } from '@/cluster/node';
import { emitProjectEvent } from './webhookController';
import { buildIncidentCreatedEvent, buildIncidentResolvedEvent, buildIncidentUpdatedEvent } from './webhooks/events';
import { areaLog } from '@/utils/log';

const incidentLog = areaLog('incidents');

// Statuses that mean an incident/maintenance is over (stamps resolvedAt).
const TERMINAL_STATUSES = new Set<IncidentStatus>([IncidentStatus.RESOLVED, IncidentStatus.COMPLETED]);

export const listIncidents = async (projectId: string): Promise<IncidentWithUpdates[]> => {
    const incidents = await getIncidentsByProjectModel(projectId);
    const withUpdates = await Promise.all(
        incidents.map(async (incident) => ({ incident, updates: await getUpdatesByIncidentModel(incident.id) }))
    );
    return withUpdates;
};

// Recent incidents for the public API (most recent first, capped).
export const getRecentIncidents = async (projectId: string, limit: number): Promise<IncidentWithUpdates[]> => {
    return (await listIncidents(projectId)).slice(0, limit);
};

export const createIncident = async (projectId: string, body: CreateIncidentBody, actor: string): Promise<IncidentWithUpdates> => {
    const title = body.title?.trim();
    if (!title) throw new Error('A title is required');
    const now = Date.now();
    const kind = body.kind === IncidentKind.MAINTENANCE ? IncidentKind.MAINTENANCE : IncidentKind.INCIDENT;
    if (kind === IncidentKind.MAINTENANCE && (!body.scheduledStart || !body.scheduledEnd)) {
        throw new Error('Scheduled maintenance requires a start and end time');
    }
    const incident: Incident = {
        id: crypto.randomUUID(),
        projectId,
        kind,
        title,
        status: body.status,
        impact: body.impact,
        startedAt: body.startedAt ?? (kind === IncidentKind.MAINTENANCE ? body.scheduledStart ?? now : now),
        resolvedAt: TERMINAL_STATUSES.has(body.status) ? now : undefined,
        scheduledStart: kind === IncidentKind.MAINTENANCE ? body.scheduledStart : undefined,
        scheduledEnd: kind === IncidentKind.MAINTENANCE ? body.scheduledEnd : undefined,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_INCIDENT, incident });

    if (body.body?.trim()) {
        const update: IncidentUpdate = { id: crypto.randomUUID(), incidentId: incident.id, status: incident.status, body: body.body.trim(), createdBy: actor, createdAt: now };
        await cluster.propose({ type: OpType.ADD_INCIDENT_UPDATE, update });
    }
    incidentLog.info({ action: 'incident_created', projectId, incidentId: incident.id, kind, status: incident.status }, `incident created for ${projectId}`);
    void emitProjectEvent(buildIncidentCreatedEvent(incident));
    return { incident, updates: await getUpdatesByIncidentModel(incident.id) };
};

// Append a timeline update and advance the incident's status (and resolvedAt when terminal).
export const addIncidentUpdate = async (projectId: string, incidentId: string, body: AddIncidentUpdateBody, actor: string): Promise<IncidentWithUpdates> => {
    const incident = await getIncidentByIdModel(incidentId);
    if (!incident || incident.projectId !== projectId) throw new Error('Incident not found');
    if (!body.body?.trim()) throw new Error('An update message is required');
    const now = Date.now();
    const update: IncidentUpdate = { id: crypto.randomUUID(), incidentId, status: body.status, body: body.body.trim(), createdBy: actor, createdAt: now };
    await cluster.propose({ type: OpType.ADD_INCIDENT_UPDATE, update });

    const resolvedAt = TERMINAL_STATUSES.has(body.status) ? incident.resolvedAt ?? now : incident.resolvedAt;
    const updated: Incident = { ...incident, status: body.status, resolvedAt, updatedAt: now };
    await cluster.propose({ type: OpType.UPSERT_INCIDENT, incident: updated });
    incidentLog.info({ action: 'incident_update_added', projectId, incidentId, status: body.status }, `update added to incident ${incidentId}`);
    void emitProjectEvent(TERMINAL_STATUSES.has(body.status) ? buildIncidentResolvedEvent(updated, update) : buildIncidentUpdatedEvent(updated, update));
    return { incident: updated, updates: await getUpdatesByIncidentModel(incidentId) };
};

// Edit incident metadata (title/impact/status/schedule) without appending a timeline entry.
export const updateIncident = async (projectId: string, incidentId: string, body: UpdateIncidentBody, actor: string): Promise<IncidentWithUpdates> => {
    const incident = await getIncidentByIdModel(incidentId);
    if (!incident || incident.projectId !== projectId) throw new Error('Incident not found');
    const now = Date.now();
    const status = body.status ?? incident.status;
    const resolvedAt = TERMINAL_STATUSES.has(status) ? incident.resolvedAt ?? now : status !== incident.status ? undefined : incident.resolvedAt;
    const updated: Incident = {
        ...incident,
        title: body.title?.trim() || incident.title,
        impact: body.impact ?? incident.impact,
        status,
        scheduledStart: body.scheduledStart ?? incident.scheduledStart,
        scheduledEnd: body.scheduledEnd ?? incident.scheduledEnd,
        resolvedAt,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_INCIDENT, incident: updated });
    void actor;
    return { incident: updated, updates: await getUpdatesByIncidentModel(incidentId) };
};

export const deleteIncident = async (projectId: string, incidentId: string): Promise<void> => {
    const incident = await getIncidentByIdModel(incidentId);
    if (!incident || incident.projectId !== projectId) return;
    await cluster.propose({ type: OpType.DELETE_INCIDENT, incidentId });
    incidentLog.info({ action: 'incident_deleted', projectId, incidentId }, `incident ${incidentId} deleted`);
};

export const clearProjectIncidents = async (projectId: string): Promise<void> => {
    await deleteIncidentsForProjectModel(projectId);
};
