import { sequelize } from '@/utils/dbHelper';
import { HealthCheckType, HealthStatus, ProjectHealthSample } from '@mosaiq/nsm-common/types';
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
