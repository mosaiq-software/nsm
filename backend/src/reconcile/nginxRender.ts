import * as fs from 'fs/promises';
import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { sudo } from '@/host/privilege';
import { getAllDesiredDeploymentsModel } from '@/persistence/desiredDeploymentPersistence';
import { getAllCertsModel } from '@/persistence/certPersistence';
import { dashboardDomain, buildDashboardConf, DASHBOARD_CONF_NAME } from './dashboardIngress';

// The leader is the single TLS ingress, so only the leader renders nginx. It renders one conf per
// project (from its authoritative desired-deployment set); each conf's proxy_pass targets a
// backend node by its stable internal hostname (resolved via the leader's /etc/hosts).
// Drop references to certbot-installer-only files from already-frozen confs. Older deployments
// baked in `include options-ssl-nginx.conf` / `ssl_dhparam ssl-dhparams.pem`, but those files are
// never created by `certbot certonly`, so they'd fail `nginx -t`. New confs no longer emit them
// (see getSslDirectives); this keeps pre-existing frozen confs valid without a redeploy.
const stripLegacySslIncludes = (conf: string): string =>
    conf
        .split('\n')
        .filter((l) => !l.includes('/etc/letsencrypt/options-ssl-nginx.conf') && !l.includes('/etc/letsencrypt/ssl-dhparams.pem'))
        .join('\n');

export const renderAllNginx = async (): Promise<{ changed: boolean }> => {
    await fs.mkdir(config.nginxConfDir, { recursive: true });
    const deployments = await getAllDesiredDeploymentsModel();

    // Domains with an issued cert. A vhost's SSL block references live/<domain>/fullchain.pem, so
    // writing it before the cert exists makes `nginx -t` fail - which wedges every reload AND stops
    // certbot (--nginx) from running, the deadlock we must avoid. Gate every SSL vhost on this set.
    const certs = await getAllCertsModel();
    const certDomains = new Set(certs.map((c) => c.domain));

    const desiredFiles = new Map<string, string>();
    for (const dep of deployments) {
        if (!dep.nginxConf || !dep.nginxConf.trim().length) continue;
        const missing = (dep.domains || []).filter((d) => !certDomains.has(d));
        if (missing.length) {
            // Defer this project's vhost until all its domains have certs. The stale-file cleanup
            // below then removes any previously-written (now cert-less) conf so nginx stays valid.
            console.warn(`[nginx] deferring ${dep.projectId}.conf until certs are issued for: ${missing.join(', ')}`);
            continue;
        }
        desiredFiles.set(`${dep.projectId}.conf`, stripLegacySslIncludes(dep.nginxConf));
    }

    // Front the management dashboard over TLS once its cert exists (same gating rationale).
    const dashDomain = dashboardDomain();
    if (dashDomain && certDomains.has(dashDomain)) {
        desiredFiles.set(DASHBOARD_CONF_NAME, buildDashboardConf(dashDomain));
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
        const test = await execSafe(sudo('nginx -t'), 10000);
        if (test.code !== 0) {
            console.error('nginx -t failed, not reloading:', test.out);
            return { changed: false };
        }
        const reload = await execSafe(sudo('nginx -s reload'), 10000);
        if (reload.code !== 0) console.error('nginx reload failed:', reload.out);
    }

    return { changed };
};
