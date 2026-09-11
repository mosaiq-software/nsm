import { describe, it, expect } from 'vitest';
import { assembleDotenv, parseDotenv, extractSecretsFromDockerCompose, buildRawVarsIntoSecrets, stringifyDynamicVariablePath, parseDynamicVariablePath, extractVariables } from '@mosaiq/nsm-common/secretUtil';
import { DynamicEnvVariableFields, NginxConfigLocationType, Project } from '@mosaiq/nsm-common/types';

describe('parseDotenv', () => {
    it('skips comments and blank lines and preserves = inside values', () => {
        const secrets = parseDotenv('# comment\nFOO=bar\n\nBAZ=with=eq # trailing', 'p1');
        expect(secrets.map((s) => s.secretName)).toEqual(['FOO', 'BAZ']);
        expect(secrets.every((s) => s.projectId === 'p1' && s.secretValue === '' && s.variable === false)).toBe(true);
        expect(secrets[0].secretPlaceholder).toBe('bar (from .env)');
        expect(secrets[1].secretPlaceholder).toBe('with=eq (from .env)');
    });

    it('truncates long placeholder values', () => {
        const long = 'x'.repeat(80);
        const secrets = parseDotenv(`K=${long}`, 'p1');
        expect(secrets[0].secretPlaceholder).toBe(`${'x'.repeat(60)}... (from .env)`);
    });
});

describe('assembleDotenv', () => {
    it('joins name=value pairs with newlines', () => {
        const out = assembleDotenv([
            { projectId: 'p', secretName: 'A', secretValue: '1', secretPlaceholder: '', variable: false },
            { projectId: 'p', secretName: 'B', secretValue: '2', secretPlaceholder: '', variable: false },
        ]);
        expect(out).toBe('A=1\nB=2');
    });
});

describe('extractSecretsFromDockerCompose', () => {
    it('extracts ${VAR} references', () => {
        const compose = 'services:\n  x:\n    image: ${IMAGE}\n    environment:\n      - FOO=${BAR}\n';
        const secrets = extractSecretsFromDockerCompose(compose, 'p1');
        expect(secrets.map((s) => s.secretName).sort()).toEqual(['BAR', 'IMAGE']);
        expect(secrets[0].secretPlaceholder).toBe('(from docker compose)');
    });
});

describe('buildRawVarsIntoSecrets', () => {
    it('dedupes and tags the source', () => {
        const secrets = buildRawVarsIntoSecrets(['A', 'A', 'B'], 'p1', 'JS Source Code');
        expect(secrets.map((s) => s.secretName)).toEqual(['A', 'B']);
        expect(secrets[0].secretPlaceholder).toBe('(from JS Source Code)');
    });
});

describe('dynamic variable path', () => {
    it('round-trips with defined ids', () => {
        const p = stringifyDynamicVariablePath('p1', 's1', 'l1', DynamicEnvVariableFields.URL);
        expect(p).toBe('p1.s1.l1.URL');
        expect(parseDynamicVariablePath(p)).toEqual({ projectId: 'p1', serverId: 's1', locationId: 'l1', field: 'URL' });
    });

    it('maps underscore placeholders back to undefined', () => {
        const p = stringifyDynamicVariablePath('p1', undefined, undefined, DynamicEnvVariableFields.VOLUME);
        expect(p).toBe('p1._._.Volume');
        expect(parseDynamicVariablePath(p)).toEqual({ projectId: 'p1', serverId: undefined, locationId: undefined, field: 'Volume' });
    });

    it('throws on malformed paths', () => {
        expect(() => parseDynamicVariablePath('nope')).toThrow();
    });
});

describe('extractVariables', () => {
    it('emits general + per-location variables', () => {
        const project = {
            id: 'p1',
            nginxConfig: {
                servers: [
                    {
                        serverId: 's1',
                        domain: 'example.com',
                        wildcardSubdomain: false,
                        locations: [
                            { locationId: 'lstatic', type: NginxConfigLocationType.STATIC, path: '/', serveDir: '', spa: false, explicitCors: false },
                            { locationId: 'lproxy', type: NginxConfigLocationType.PROXY, path: '/api', proxyPass: '', websocketSupport: false },
                            { locationId: 'lredirect', type: NginxConfigLocationType.REDIRECT, path: '/old', target: 'https://x' },
                        ],
                    },
                ],
            },
        } as unknown as Project;
        const paths = extractVariables(project).map((v) => v.path);
        expect(paths).toContain('p1._._.WorkerNodeId');
        expect(paths).toContain('p1._._.Volume');
        expect(paths).toContain('p1.s1._.Domain');
        expect(paths).toContain('p1.s1.lstatic.Directory');
        expect(paths).toContain('p1.s1.lproxy.Port');
        expect(paths).toContain('p1.s1.lredirect.Target');
    });
});
