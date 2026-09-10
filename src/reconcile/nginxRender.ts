import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';

// Every node renders the nginx config for ALL projects in the cluster (not just its own),
// so whichever node holds the VIP can serve traffic immediately after a failover.
// The per-project nginx conf is produced by the leader and replicated inside each
// DesiredDeployment, so it is available on every node's local view.
export const renderAllNginx = async (): Promise<{ changed: boolean }> => {
    await fs.mkdir(config.nginxConfDir, { recursive: true });
    const deployments = await getAllDesiredDeploymentsModel();

    const desiredFiles = new Map<string, string>();
    for (const dep of deployments) {
        if (dep.nginxConf && dep.nginxConf.trim().length) {
            desiredFiles.set(`${dep.projectId}.conf`, dep.nginxConf);
        }
    }

    let changed = false;

    // Write / update conf files.
    for (const [name, contents] of desiredFiles) {
        const path = `${config.nginxConfDir}/${name}`;
        let current = '';
        try {
            current = await fs.readFile(path, 'utf-8');
        } catch {
            /* new file */
        }
        if (current !== contents) {
            await fs.writeFile(path, contents);
            changed = true;
        }
    }

    // Remove conf files for projects that no longer exist.
    let existing: string[] = [];
    try {
        existing = await fs.readdir(config.nginxConfDir);
    } catch {
        existing = [];
    }
    for (const file of existing) {
        if (!file.endsWith('.conf')) continue;
        if (!desiredFiles.has(file)) {
            await fs.rm(`${config.nginxConfDir}/${file}`, { force: true });
            changed = true;
        }
    }

    if (changed && config.production) {
        const test = await execSafe('nginx -t', 10000);
        if (test.code !== 0) {
            console.error('nginx -t failed, not reloading:', test.out);
            return { changed: false };
        }
        const reload = await execSafe('nginx -s reload', 10000);
        if (reload.code !== 0) console.error('nginx reload failed:', reload.out);
    }

    return { changed };
};
