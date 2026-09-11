import { FullDirectoryMap, RelativeDirectoryMap } from '@mosaiq/nsm-common/types';
import * as fs from 'fs/promises';
import { config } from '@/config';

// Ensures persistent/non-persistent directories exist on this host and returns their full paths.
// Ported from server-manager-worker/src/persistenceUtils.ts (now direct host fs access).
export const ensureDirectories = async (map: RelativeDirectoryMap): Promise<FullDirectoryMap> => {
    if (!config.production) {
        const mockBase = '/mock/persistent';
        const result: FullDirectoryMap = {};
        for (const key in map) result[key] = { fullPath: `${mockBase}/${map[key].relPath.replace(/^\/+/, '')}` };
        return result;
    }
    const basePath = config.persistentPath;
    const fullPaths: FullDirectoryMap = {};
    for (const key in map) fullPaths[key] = { fullPath: `${basePath}/${map[key].relPath.replace(/^\/+/, '')}` };
    for (const key in fullPaths) {
        await fs.mkdir(fullPaths[key].fullPath, { recursive: true });
    }
    return fullPaths;
};
