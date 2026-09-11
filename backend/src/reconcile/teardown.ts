import { config } from '@/config';
import { execStream } from '@/host/exec';

// Tears down a project's containers on this host. Direct host exec (no worker RPC / pipe).
export const teardownProjectLocal = async (projectId: string): Promise<void> => {
    if (!config.production) return;
    const teardownCommand = `docker compose -p ${projectId} down`;
    const pruneCommand = `docker system prune -af`;
    const cmd = `(cd ${config.deploymentPath}/${projectId} && ${teardownCommand} && ${pruneCommand})`;
    const timeoutMs = 3 * 60 * 1000;
    try {
        const { out, code } = await execStream(cmd, timeoutMs);
        if (code !== 0) console.warn(`Teardown for ${projectId} exited with code ${code}: ${out}`);
    } catch (e: any) {
        console.error(`Error running teardown command for ${projectId}: ${e.message}`);
    }
};
