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

export const HTTP_CHALLENGE_CONF_NAME = '_nsm_http_challenge.conf';

// A minimal :80 vhost for domains that don't yet have a cert. It exists purely so certbot's --nginx
// (http-01) authenticator has a server block matching the domain to inject its challenge location
// into; all other requests 404. Once a domain is certified it is served by its real vhost and drops
// out of this conf.
const buildHttpChallengeConf = (domains: string[]): string => {
    const names = domains.join(' ');
    return ['server {', '    listen 80;', '    listen [::]:80;', `    server_name ${names};`, '    location / { return 404; }', '}', ''].join('\n');
};

export const renderAllNginx = async (): Promise<{ changed: boolean }> => {
    await fs.mkdir(config.nginxConfDir, { recursive: true });
    const deployments = await getAllDesiredDeploymentsModel();

    // Domains with an issued cert. A vhost's SSL block references live/<domain>/fullchain.pem, so
    // writing it before the cert exists makes `nginx -t` fail - which wedges every reload AND stops
    // certbot (--nginx) from running, the deadlock we must avoid. Gate every SSL vhost on this set.
    const certs = await getAllCertsModel();
    const certDomains = new Set(certs.map((c) => c.domain));

    const desiredFiles = new Map<string, string>();
    // Domains that still need a cert: they get a plain :80 challenge vhost so certbot --nginx (http-01)
    // always has a server block to answer on, even before the project's real (gated) vhost exists.
    const challengeDomains = new Set<string>();
    for (const dep of deployments) {
        // Serve the ACTIVE generation's conf/domains (what has passed its readiness gate), not the
        // pending one. For zero-downtime this trails until cutover; legacy deployments set the active
        // fields to the pending values immediately. Fall back to the legacy `nginxConf`/`domains` for
        // rows written before this field existed.
        const serveConf = dep.zeroDowntime ? dep.activeNginxConf : dep.activeNginxConf ?? dep.nginxConf;
        const serveDomains = dep.zeroDowntime ? dep.activeDomains ?? [] : dep.activeDomains ?? dep.domains ?? [];

        // Any pending domain without a cert needs the http-01 challenge vhost.
        for (const d of dep.domains || []) if (!certDomains.has(d)) challengeDomains.add(d);

        if (!serveConf || !serveConf.trim().length) continue;
        const missing = (serveDomains || []).filter((d) => !certDomains.has(d));
        if (missing.length) {
            // Defer this project's vhost until all its (active) domains have certs. The stale-file
            // cleanup below then removes any previously-written (now cert-less) conf so nginx stays valid.
            console.warn(`[nginx] deferring ${dep.projectId}.conf until certs are issued for: ${missing.join(', ')}`);
            continue;
        }
        desiredFiles.set(`${dep.projectId}.conf`, stripLegacySslIncludes(serveConf));
    }

    // A single :80 challenge vhost for all not-yet-certified domains. Domains that already have a
    // cert are served by their real vhost (above), so there is no server_name overlap.
    if (challengeDomains.size) {
        desiredFiles.set(HTTP_CHALLENGE_CONF_NAME, buildHttpChallengeConf(Array.from(challengeDomains)));
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
