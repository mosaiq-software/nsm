import crypto from 'crypto';
import { CreatePortReservationBody, PortProtocol, PortReservation } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import {
    getAllPortReservationsModel,
    getPortReservationByIdModel,
    getPortReservationsByNodeAndProjectModel,
    getPortReservationsByNodeModel,
    getPortReservationsByProjectModel,
} from '@/persistence/portReservationPersistence';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { getProjectByIdModel } from '@/persistence/projectPersistence';
import { getReservedPorts } from '@/reconcile/ports';
import { cluster } from '@/cluster/node';
import { syncPortBoundRecords } from './dnsController';
import { areaLog } from '@/utils/log';

const reservationLog = areaLog('ports');

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const listNodeReservations = async (nodeId: string): Promise<PortReservation[]> => {
    return (await getPortReservationsByNodeModel(nodeId)).sort((a, b) => a.port - b.port);
};

export const listProjectReservations = async (projectId: string): Promise<PortReservation[]> => {
    return (await getPortReservationsByProjectModel(projectId)).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.port - b.port);
};

export const listAllReservations = async (): Promise<PortReservation[]> => {
    return (await getAllPortReservationsModel()).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.port - b.port);
};

export const createReservation = async (nodeId: string, body: CreatePortReservationBody): Promise<PortReservation> => {
    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found in cluster`);

    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535');

    const protocol = body.protocol;
    if (protocol !== PortProtocol.TCP && protocol !== PortProtocol.UDP) throw new Error('Protocol must be tcp or udp');

    const envVarName = (body.envVarName || '').trim();
    if (!ENV_VAR_RE.test(envVarName)) throw new Error('Environment variable name must match ^[A-Za-z_][A-Za-z0-9_]*$');

    if (!body.projectId) throw new Error('A project is required');
    const project = await getProjectByIdModel(body.projectId);
    if (!project) throw new Error(`Project ${body.projectId} not found`);

    if (getReservedPorts().has(port)) throw new Error(`Port ${port} is reserved by NSM's control plane / observability stack and cannot be forwarded`);

    const existing = await getPortReservationsByNodeModel(nodeId);
    if (existing.some((r) => r.port === port && r.protocol === protocol)) {
        throw new Error(`Port ${port}/${protocol} is already reserved on ${nodeId}`);
    }
    if (existing.some((r) => r.projectId === body.projectId && r.envVarName === envVarName)) {
        throw new Error(`Environment variable ${envVarName} is already used by another reservation for this project on ${nodeId}`);
    }

    const reservation: PortReservation = {
        id: crypto.randomUUID(),
        nodeId,
        port,
        protocol,
        projectId: body.projectId,
        envVarName,
        label: body.label?.trim() || undefined,
        created: Date.now(),
    };
    await cluster.propose({ type: OpType.UPSERT_PORT_RESERVATION, reservation });
    reservationLog.info(
        { action: 'reservation_created', reservationId: reservation.id, nodeId, projectId: reservation.projectId, port, protocol },
        `reserved ${port}/${protocol} on ${nodeId} for ${reservation.projectId}`
    );
    return reservation;
};

export const deleteReservation = async (reservationId: string): Promise<void> => {
    const existing = await getPortReservationByIdModel(reservationId);
    if (!existing) return;
    await cluster.propose({ type: OpType.DELETE_PORT_RESERVATION, reservationId });
    reservationLog.info({ action: 'reservation_deleted', reservationId, nodeId: existing.nodeId, projectId: existing.projectId, port: existing.port }, `deleted reservation ${reservationId}`);
    // Strip the binding from any DNS records that referenced this reservation (keeps last port value).
    await syncPortBoundRecords(reservationId);
};

// Re-export for symmetry with node/project lookups used during deploy planning.
export { getPortReservationsByNodeAndProjectModel };
