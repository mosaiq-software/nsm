import * as fs from 'fs/promises';
import { config } from '@/config';
import { areaLog } from '@/utils/log';

const stateLog = areaLog('state');

// Tracks which generation(s) of each project are deployed on THIS host, so the reconciler can
// survive restarts without redeploying, detect projects that moved away, and (for zero-downtime
// deploys) know which old generations to drain once a new one is promoted.
//
// Marker shape on disk is JSON: { deployedGeneration, readyGeneration, liveGenerations }.
// For back-compat a legacy marker written by an older nsmd is a bare integer; it is read as a
// single fully-deployed, ready generation.
const genDir = () => `${config.databaseDir}/generations`;

export interface GenMarker {
    // Highest generation whose containers this node has brought up (blue), ready or not.
    deployedGeneration: number | null;
    // Highest generation this node has reported ready to the leader (passed the readiness gate).
    readyGeneration: number | null;
    // Generations whose containers are still running on this host (old + new during a rotation).
    liveGenerations: number[];
}

const emptyMarker = (): GenMarker => ({ deployedGeneration: null, readyGeneration: null, liveGenerations: [] });

export const readMarker = async (projectId: string): Promise<GenMarker> => {
    try {
        const raw = (await fs.readFile(`${genDir()}/${projectId}`, 'utf-8')).trim();
        // Legacy format: a bare integer generation.
        if (/^\d+$/.test(raw)) {
            const n = parseInt(raw, 10);
            return { deployedGeneration: n, readyGeneration: n, liveGenerations: [n] };
        }
        const parsed = JSON.parse(raw) as Partial<GenMarker>;
        return {
            deployedGeneration: parsed.deployedGeneration ?? null,
            readyGeneration: parsed.readyGeneration ?? null,
            liveGenerations: Array.isArray(parsed.liveGenerations) ? parsed.liveGenerations : [],
        };
    } catch {
        return emptyMarker();
    }
};

const writeMarker = async (projectId: string, marker: GenMarker): Promise<void> => {
    await fs.mkdir(genDir(), { recursive: true });
    await fs.writeFile(`${genDir()}/${projectId}`, JSON.stringify(marker));
};

export const getLocalGeneration = async (projectId: string): Promise<number | null> => {
    return (await readMarker(projectId)).deployedGeneration;
};

export const getReadyGeneration = async (projectId: string): Promise<number | null> => {
    return (await readMarker(projectId)).readyGeneration;
};

export const getLiveGenerations = async (projectId: string): Promise<number[]> => {
    return (await readMarker(projectId)).liveGenerations;
};

// Legacy/in-place path: a single generation is deployed, ready, and live at once.
export const setLocalGeneration = async (projectId: string, generation: number): Promise<void> => {
    await writeMarker(projectId, { deployedGeneration: generation, readyGeneration: generation, liveGenerations: [generation] });
    stateLog.debug({ action: 'generation_set', projectId, generation }, `local generation set to ${generation}`);
};

// Zero-downtime: a new generation's containers are up (blue). Record it as deployed + live without
// yet marking it ready (that happens once the readiness gate passes).
export const markGenerationLive = async (projectId: string, generation: number): Promise<void> => {
    const m = await readMarker(projectId);
    const liveGenerations = Array.from(new Set([...m.liveGenerations, generation]));
    await writeMarker(projectId, { ...m, deployedGeneration: generation, liveGenerations });
    stateLog.debug({ action: 'generation_live', projectId, generation, liveGenerations }, `generation ${generation} marked live`);
};

export const markGenerationReady = async (projectId: string, generation: number): Promise<void> => {
    const m = await readMarker(projectId);
    await writeMarker(projectId, {
        ...m,
        readyGeneration: generation,
        deployedGeneration: Math.max(m.deployedGeneration ?? generation, generation),
    });
    stateLog.debug({ action: 'generation_ready', projectId, generation }, `generation ${generation} marked ready`);
};

export const removeLiveGeneration = async (projectId: string, generation: number): Promise<void> => {
    const m = await readMarker(projectId);
    await writeMarker(projectId, { ...m, liveGenerations: m.liveGenerations.filter((g) => g !== generation) });
    stateLog.debug({ action: 'generation_removed', projectId, generation }, `generation ${generation} removed from live set`);
};

export const clearLocalGeneration = async (projectId: string): Promise<void> => {
    try {
        await fs.rm(`${genDir()}/${projectId}`, { force: true });
        stateLog.debug({ action: 'generation_cleared', projectId }, `local generation marker cleared for ${projectId}`);
    } catch {
        /* ignore */
    }
};

export const listLocalProjects = async (): Promise<string[]> => {
    try {
        return await fs.readdir(genDir());
    } catch {
        return [];
    }
};
