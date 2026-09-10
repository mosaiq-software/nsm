import { DockerContainerData } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { execSafe } from '@/host/exec';

interface RawDockerContainerData extends Omit<DockerContainerData, 'Labels'> {
    Labels: string;
}

export const listContainerData = async (): Promise<DockerContainerData[]> => {
    if (!config.production) {
        return [];
    }
    const cmd = `docker ps --all --no-trunc --format json`;
    const { out, code } = await execSafe(cmd, 1000 * 10);
    if (code !== 0) {
        throw new Error(`Error listing containers, code ${code}, out: ${out}`);
    }
    // docker outputs one JSON object per line.
    const lines = out
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'));
    const json: RawDockerContainerData[] = [];
    for (const line of lines) {
        try {
            json.push(JSON.parse(line));
        } catch {
            /* skip malformed line */
        }
    }
    return json.map((container) => {
        const labels: { [key: string]: string } = {};
        (container.Labels || '').split(',').forEach((kvp) => {
            const [key, ...rest] = kvp.split('=');
            if (key) labels[key] = rest.join('=');
        });
        return { ...container, Labels: labels } as DockerContainerData;
    });
};
