import { sequelize } from '@/utils/dbHelper';
import { HealthCheckType, HealthStatus, ProjectHealthRollup, ProjectHealthSample } from '@mosaiq/nsm-common/types';
import { DataTypes, Model, Op, QueryTypes } from 'sequelize';

// Time series of project health observations, one row per check target per sample tick. Leader-
// local observational data (written by the leader's health-sampler cron), not replicated via
// cluster ops - like the disk-usage gauge, it is high-frequency and does not belong in the
// deterministic state machine.
class ProjectHealthSampleModel extends Model {}
ProjectHealthSampleModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        checkType: DataTypes.STRING,
        target: DataTypes.STRING,
        status: DataTypes.STRING,
        latencyMs: DataTypes.NUMBER,
        detail: DataTypes.TEXT,
        ts: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false, indexes: [{ fields: ['projectId', 'ts'] }] }
);

const toSample = (row: any): ProjectHealthSample => ({
    id: row.id,
    projectId: row.projectId,
    checkType: row.checkType as HealthCheckType,
    target: row.target,
    status: row.status as HealthStatus,
    latencyMs: row.latencyMs ?? undefined,
    detail: row.detail ?? undefined,
    ts: row.ts,
});

export const insertHealthSamplesModel = async (samples: ProjectHealthSample[]): Promise<void> => {
    if (!samples.length) return;
    await ProjectHealthSampleModel.bulkCreate(samples.map((s) => ({ ...s })));
};

// The most recent sample for each distinct (checkType, target) of a project.
export const getLatestSamplesForProjectModel = async (projectId: string): Promise<ProjectHealthSample[]> => {
    const rows = (await sequelize.query(
        `SELECT s.* FROM ProjectHealthSampleModels s
         JOIN (
             SELECT checkType, target, MAX(ts) AS maxTs
             FROM ProjectHealthSampleModels
             WHERE projectId = :projectId
             GROUP BY checkType, target
         ) m ON s.checkType = m.checkType AND s.target = m.target AND s.ts = m.maxTs
         WHERE s.projectId = :projectId`,
        { replacements: { projectId }, type: QueryTypes.SELECT }
    )) as any[];
    return rows.map(toSample);
};

export const getSamplesInRangeModel = async (projectId: string, since: number): Promise<ProjectHealthSample[]> => {
    const rows = (await sequelize.query(`SELECT * FROM ProjectHealthSampleModels WHERE projectId = :projectId AND ts >= :since ORDER BY ts ASC`, {
        replacements: { projectId, since },
        type: QueryTypes.SELECT,
    })) as any[];
    return rows.map(toSample);
};

export const pruneHealthSamplesModel = async (before: number): Promise<number> => {
    return ProjectHealthSampleModel.destroy({ where: { ts: { [Op.lt]: before } } });
};

export const deleteHealthSamplesForProjectModel = async (projectId: string): Promise<void> => {
    await ProjectHealthSampleModel.destroy({ where: { projectId } });
};

// Downsampled hourly aggregates of the raw samples above. Retained far longer than raw (raw is
// pruned after a short window) so the status page and public API keep a full history cheaply.
class ProjectHealthRollupModel extends Model {}
ProjectHealthRollupModel.init(
    {
        id: { type: DataTypes.STRING, primaryKey: true },
        projectId: DataTypes.STRING,
        checkType: DataTypes.STRING,
        target: DataTypes.STRING,
        bucketStart: DataTypes.NUMBER,
        granularityMs: DataTypes.NUMBER,
        total: DataTypes.NUMBER,
        upSamples: DataTypes.NUMBER,
        degradedSamples: DataTypes.NUMBER,
        downSamples: DataTypes.NUMBER,
        sumLatencyMs: DataTypes.NUMBER,
        latencyCount: DataTypes.NUMBER,
    },
    { sequelize, timestamps: false, indexes: [{ fields: ['projectId', 'bucketStart'] }] }
);

const toRollup = (row: any): ProjectHealthRollup => ({
    id: row.id,
    projectId: row.projectId,
    checkType: row.checkType as HealthCheckType,
    target: row.target,
    bucketStart: row.bucketStart,
    granularityMs: row.granularityMs,
    total: row.total,
    upSamples: row.upSamples,
    degradedSamples: row.degradedSamples,
    downSamples: row.downSamples,
    sumLatencyMs: row.sumLatencyMs,
    latencyCount: row.latencyCount,
});

// Idempotent upsert: recomputing a bucket from raw and re-writing it must overwrite the prior row.
export const upsertHealthRollupsModel = async (rows: ProjectHealthRollup[]): Promise<void> => {
    if (!rows.length) return;
    await ProjectHealthRollupModel.bulkCreate(
        rows.map((r) => ({ ...r })),
        { updateOnDuplicate: ['total', 'upSamples', 'degradedSamples', 'downSamples', 'sumLatencyMs', 'latencyCount', 'granularityMs'] }
    );
};

export const getRollupsInRangeModel = async (projectId: string, since: number): Promise<ProjectHealthRollup[]> => {
    const rows = (await sequelize.query(`SELECT * FROM ProjectHealthRollupModels WHERE projectId = :projectId AND bucketStart >= :since ORDER BY bucketStart ASC`, {
        replacements: { projectId, since },
        type: QueryTypes.SELECT,
    })) as any[];
    return rows.map(toRollup);
};

export const pruneHealthRollupsModel = async (before: number): Promise<number> => {
    return ProjectHealthRollupModel.destroy({ where: { bucketStart: { [Op.lt]: before } } });
};

export const deleteHealthRollupsForProjectModel = async (projectId: string): Promise<void> => {
    await ProjectHealthRollupModel.destroy({ where: { projectId } });
};
