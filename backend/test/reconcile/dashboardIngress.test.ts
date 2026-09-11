import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// config.publicUrl is computed at import time, so reset modules and import per variant.
describe('dashboardIngress', () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => vi.unstubAllEnvs());

    const load = async (publicUrl: string) => {
        vi.stubEnv('NSM_PUBLIC_URL', publicUrl);
        return import('@/reconcile/dashboardIngress');
    };

    it('returns the FQDN for an https public URL', async () => {
        const { dashboardDomain } = await load('https://nsm.example.com');
        expect(dashboardDomain()).toBe('nsm.example.com');
    });

    it('ignores a trailing path/port and keeps just the host', async () => {
        const { dashboardDomain } = await load('https://nsm.example.com:8443/app');
        expect(dashboardDomain()).toBe('nsm.example.com');
    });

    it('returns null for non-TLS or non-certifiable hosts', async () => {
        for (const url of ['http://nsm.example.com', 'https://localhost', 'https://10.0.0.5:1025', 'https://leader']) {
            vi.resetModules();
            const { dashboardDomain } = await load(url);
            expect(dashboardDomain(), url).toBeNull();
        }
    });

    it('builds a TLS vhost that proxies the domain to the local daemon', async () => {
        const { buildDashboardConf } = await load('https://nsm.example.com');
        const { config } = await import('@/config');
        const conf = buildDashboardConf('nsm.example.com');
        expect(conf).toContain('server_name nsm.example.com;');
        expect(conf).toContain('listen 443 ssl;');
        expect(conf).toContain('listen 80;');
        expect(conf).toContain(`proxy_pass http://127.0.0.1:${config.apiPort};`);
        expect(conf).toContain('/etc/letsencrypt/live/nsm.example.com/fullchain.pem');
        expect(conf).toContain('return 301 https://$host$request_uri;');
    });
});
