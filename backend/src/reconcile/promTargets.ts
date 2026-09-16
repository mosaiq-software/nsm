import * as fs from 'fs/promises';
import { config } from '@/config';
import { getAllNodesModel } from '@/persistence/nodePersistence';
import { areaLog } from '@/utils/log';

const promLog = areaLog('promTargets');

// Prometheus file-based service discovery. The leader regenerates one target file per job from
// the registry, addressing every node by its stable internal hostname (<nodeId>.<internalDomain>)
// so scraping is IP-less. Prometheus hot-reloads these files automatically.
const PROM_SD_DIR = '/etc/nsm/prometheus';

interface PromTargetGroup {
    labels: { [k: string]: string };
    targets: string[];
}

const writeIfChanged = async (path: string, contents: string): Promise<boolean> => {
    let current = '';
    try {
        current = await fs.readFile(path, 'utf-8');
    } catch {
        /* new file */
    }
    if (current !== contents) {
        await fs.writeFile(path, contents);
        return true;
    }
    return false;
};

// Exposed for unit testing without touching disk.
export const buildTargetGroups = (nodes: { nodeId: string }[], domain: string, port: number): PromTargetGroup[] =>
    nodes.map((n) => ({ labels: { nodeId: n.nodeId }, targets: [`${n.nodeId}.${domain}:${port}`] }));

export const regeneratePromTargets = async (): Promise<void> => {
    if (!config.production) return;
    await fs.mkdir(PROM_SD_DIR, { recursive: true });
    const nodes = await getAllNodesModel();
    const jobs: { file: string; port: number }[] = [
        { file: 'targets_node.json', port: 9100 }, // node_exporter
        { file: 'targets_cadvisor.json', port: 8080 }, // cadvisor
        { file: 'targets_nsmd.json', port: config.apiPort }, // nsmd /metrics
    ];
    const changedFiles: string[] = [];
    for (const job of jobs) {
        const groups = buildTargetGroups(nodes, config.internalDomain, job.port);
        if (await writeIfChanged(`${PROM_SD_DIR}/${job.file}`, JSON.stringify(groups, null, 2))) changedFiles.push(job.file);
    }
    if (changedFiles.length) {
        promLog.info({ action: 'prom_targets_regenerated', nodeCount: nodes.length, changedFiles }, `regenerated ${changedFiles.length} prometheus target file(s)`);
    }
};
