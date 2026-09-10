import * as fs from 'fs/promises';
import { config } from '@/config';

// Tracks which generation of each project is currently deployed on THIS host, so the
// reconciler can survive restarts without redeploying and can detect projects that moved away.
const genDir = () => `${config.databaseDir}/generations`;

export const getLocalGeneration = async (projectId: string): Promise<number | null> => {
    try {
        const v = await fs.readFile(`${genDir()}/${projectId}`, 'utf-8');
        const n = parseInt(v.trim(), 10);
        return isNaN(n) ? null : n;
    } catch {
        return null;
    }
};

export const setLocalGeneration = async (projectId: string, generation: number): Promise<void> => {
    await fs.mkdir(genDir(), { recursive: true });
    await fs.writeFile(`${genDir()}/${projectId}`, String(generation));
};

export const clearLocalGeneration = async (projectId: string): Promise<void> => {
    try {
        await fs.rm(`${genDir()}/${projectId}`, { force: true });
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
