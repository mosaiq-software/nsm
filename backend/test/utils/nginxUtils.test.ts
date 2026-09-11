import { describe, it, expect } from 'vitest';
import { getStaticLocation, getProxyLocation, getRedirectLocation, getCustomLocation, get80Server, get443Server, buildNginxConfigForProject } from '@/utils/nginxUtils';
import { NginxConfigLocationType, Project, ProxyConfigLocation, StaticConfigLocation } from '@mosaiq/nsm-common/types';

const staticLoc = (over: Partial<StaticConfigLocation> = {}): StaticConfigLocation => ({ locationId: 'l', type: NginxConfigLocationType.STATIC, path: '/', serveDir: '/www/site', spa: false, explicitCors: false, ...over });
const proxyLoc = (over: Partial<ProxyConfigLocation> = {}): ProxyConfigLocation => ({ locationId: 'l', type: NginxConfigLocationType.PROXY, path: '/api', proxyPass: 'http://10.0.0.2:1234', websocketSupport: false, ...over });

describe('location blocks', () => {
    it('renders a plain static root', () => {
        const out = getStaticLocation(staticLoc());
        expect(out).toContain('location /');
        expect(out).toContain('root /www/site;');
        expect(out).not.toContain('try_files $uri @index');
    });

    it('renders an SPA fallback', () => {
        const out = getStaticLocation(staticLoc({ spa: true }));
        expect(out).toContain('try_files $uri @index');
        expect(out).toContain('location @index');
    });

    it('adds CORS headers when explicitCors is set', () => {
        const out = getStaticLocation(staticLoc({ explicitCors: true }));
        expect(out).toContain("Access-Control-Allow-Origin");
    });

    it('renders proxy pass with optional features', () => {
        const base = getProxyLocation(proxyLoc());
        expect(base).toContain('proxy_pass http://10.0.0.2:1234;');
        expect(base).not.toContain('proxy_read_timeout');
        const full = getProxyLocation(proxyLoc({ timeout: 30, websocketSupport: true, maxClientBodySizeMb: 50 }));
        expect(full).toContain('proxy_read_timeout          30;');
        expect(full).toContain('proxy_set_header Connection "upgrade";');
        expect(full).toContain('client_max_body_size 50M;');
    });

    it('renders redirect and custom locations', () => {
        expect(getRedirectLocation({ locationId: 'l', type: NginxConfigLocationType.REDIRECT, path: '/old', target: 'https://new' })).toContain('return 302 https://new;');
        expect(getCustomLocation({ locationId: 'l', type: NginxConfigLocationType.CUSTOM, path: '/x', content: 'add_header A b;' })).toContain('add_header A b;');
    });
});

describe('server blocks', () => {
    it('port 80 server redirects to https and returns 404', () => {
        const out = get80Server(['a.com', 'b.com']);
        expect(out).toContain('listen 80;');
        expect(out).toContain('return 301 https://$host$request_uri;');
        expect(out).toContain('return 404;');
    });

    it('port 443 server uses SSL directives keyed on the first hostname', () => {
        const out = get443Server(['a.com', 'b.com'], ['  location / {}']);
        expect(out).toContain('listen 443 ssl;');
        expect(out).toContain('/etc/letsencrypt/live/a.com/fullchain.pem');
    });
});

describe('buildNginxConfigForProject', () => {
    it('returns empty string when there is no nginx config', () => {
        expect(buildNginxConfigForProject({ id: 'p' } as Project)).toBe('');
    });

    it('expands wildcard subdomains and renders each location type', () => {
        const project = {
            id: 'p',
            nginxConfig: {
                servers: [
                    {
                        serverId: 's',
                        domain: 'example.com',
                        wildcardSubdomain: true,
                        locations: [staticLoc(), proxyLoc(), { locationId: 'r', type: NginxConfigLocationType.REDIRECT, path: '/old', target: 'https://n' }],
                    },
                ],
            },
        } as unknown as Project;
        const out = buildNginxConfigForProject(project);
        expect(out).toContain('server_name example.com *.example.com;');
        expect(out).toContain('proxy_pass http://10.0.0.2:1234;');
        expect(out).toContain('return 302 https://n;');
    });

    it('throws on an unknown location type', () => {
        const project = {
            id: 'p',
            nginxConfig: { servers: [{ serverId: 's', domain: 'x.com', wildcardSubdomain: false, locations: [{ locationId: 'l', type: 'bogus', path: '/' }] }] },
        } as unknown as Project;
        expect(() => buildNginxConfigForProject(project)).toThrow(/Unknown location type/);
    });
});
