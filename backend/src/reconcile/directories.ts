import { DirectoryBase, FullDirectoryMap, RelativeDirectoryMap } from '@mosaiq/nsm-common/types';
import * as fs from 'fs/promises';
import { config } from '@/config';
import { areaLog } from '@/utils/log';

const dirLog = areaLog('directories');

// Base path for a requested directory. Static-site resources are deploy-scoped (rebuilt each deploy);
// the per-project persistence volume (the default) lives under the persistent path.
const baseFor = (base: DirectoryBase | undefined, persistentBase: string, deployBase: string): string =>
    base === 'deploy' ? deployBase : persistentBase;

// Ensures persistent/non-persistent directories exist on this host and returns their full paths.
// Ported from server-manager-worker/src/persistenceUtils.ts (now direct host fs access).
export const ensureDirectories = async (map: RelativeDirectoryMap): Promise<FullDirectoryMap> => {
    if (!config.production) {
        const result: FullDirectoryMap = {};
        for (const key in map) result[key] = { fullPath: `${baseFor(map[key].base, '/mock/persistent', '/mock/deploy')}/${map[key].relPath.replace(/^\/+/, '')}` };
        return result;
    }
    const fullPaths: FullDirectoryMap = {};
    for (const key in map) fullPaths[key] = { fullPath: `${baseFor(map[key].base, config.persistentPath, config.deploymentPath)}/${map[key].relPath.replace(/^\/+/, '')}` };
    for (const key in fullPaths) {
        await fs.mkdir(fullPaths[key].fullPath, { recursive: true });
    }
    if (Object.keys(fullPaths).length) {
        dirLog.info({ action: 'directories_ensured', dirCount: Object.keys(fullPaths).length }, `ensured ${Object.keys(fullPaths).length} directory(ies)`);
    }
    return fullPaths;
};
