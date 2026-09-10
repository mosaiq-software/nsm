import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true } }));
vi.mock('@/utils/repositoryUtils', () => ({ getRepoData: vi.fn(), getServicesForProject: vi.fn(() => ['web']), buildDockerComposeString: vi.fn(() => '') }));

import { cluster } from '@/cluster/node';
import { applyOp } from '@/cluster/stateMachine';
import { applyRepoData, updateEnvironmentVariable, getDotenvForProject, getAllSecretsForProject } from '@/controllers/secretController';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { DeploymentState, DynamicEnvVariableFields, NginxConfigLocationType, Project, Secret } from '@mosaiq/nsm-common/types';
import { stringifyDynamicVariablePath } from '@mosaiq/nsm-common/secretUtil';
import { getProjectByIdModel } from '@/persistence/projectPersistence';

const propose = cluster.propose as unknown as Mock;
let idx = 0;

beforeEach(async () => {
    await resetDb();
    idx = 0;
    propose.mockReset();
    propose.mockImplementation(async (op: any) => applyOp(op, ++idx));
});

const seedProject = (over: Partial<Project> = {}) => applyOp({ type: OpType.UPSERT_PROJECT, project: { id: 'p1', repoOwner: 'o', repoName: 'r', state: DeploymentState.READY, deploymentKey: 'k', allowCICD: false, services: [], ...over } }, ++idx);

describe('applyRepoData', () => {
    it('preserves existing secret values, adds new ones, and updates project service metadata', async () => {
        await seedProject();
        await applyOp({ type: OpType.SET_PROJECT_SECRETS, projectId: 'p1', secrets: [{ projectId: 'p1', secretName: 'A', secretValue: 'keepme', secretPlaceholder: 'old', variable: false }] }, ++idx);

        await applyRepoData({ dotenv: 'A=fromrepo\nB=2', compose: { exists: true, contents: 'image: ${C}', parsed: { services: { web: {} } } }, jsEnvVars: ['D'] } as any, 'p1');

        const secrets = await getAllSecretsForProject('p1');
        const byName = Object.fromEntries(secrets.map((s) => [s.secretName, s]));
        expect(byName['A'].secretValue).toBe('keepme'); // preserved
        expect(Object.keys(byName).sort()).toEqual(['A', 'B', 'C', 'D']);
        const row = await getProjectByIdModel('p1');
        expect(row?.hasDockerCompose).toBe(true);
        expect(row?.hasDotenv).toBe(true);
        expect(JSON.parse(row!.servicesJson)).toEqual([{ serviceName: 'web', expectedContainerState: 'unknown', collectContainerLogs: false }]);
    });
});

describe('updateEnvironmentVariable', () => {
    it('upserts the secret and flips dirtyConfig', async () => {
        await seedProject();
        await updateEnvironmentVariable('p1', { projectId: 'p1', secretName: 'A', secretValue: 'x', secretPlaceholder: '', variable: false });
        expect((await getAllSecretsForProject('p1'))[0].secretValue).toBe('x');
        expect((await getProjectByIdModel('p1'))?.dirtyConfig).toBe(true);
    });
});

describe('getDotenvForProject (fillSecret resolution)', () => {
    it('resolves every dynamic variable field and passes through static values', async () => {
        const S = (name: string, field: DynamicEnvVariableFields, serverId?: string, locationId?: string): Secret => ({ projectId: 'p1', secretName: name, secretValue: stringifyDynamicVariablePath('p1', serverId, locationId, field), secretPlaceholder: '', variable: true });
        const project = {
            id: 'p1',
            workerNodeId: 'n9',
            nginxConfig: {
                servers: [
                    {
                        serverId: 's1',
                        domain: 'ex.com',
                        wildcardSubdomain: false,
                        locations: [
                            { locationId: 'lp', type: NginxConfigLocationType.PROXY, path: '/api', proxyPass: '', websocketSupport: false },
                            { locationId: 'ls', type: NginxConfigLocationType.STATIC, path: '/', serveDir: '', spa: false, explicitCors: false },
                            { locationId: 'lr', type: NginxConfigLocationType.REDIRECT, path: '/old', target: 'https://t' },
                        ],
                    },
                ],
            },
            secrets: [
                S('DOMAIN', DynamicEnvVariableFields.DOMAIN, 's1'),
                S('URL', DynamicEnvVariableFields.URL, 's1', 'lp'),
                S('PATH', DynamicEnvVariableFields.PATH, 's1', 'lp'),
                S('PORT', DynamicEnvVariableFields.PORT, 's1', 'lp'),
                S('TARGET', DynamicEnvVariableFields.TARGET, 's1', 'lr'),
                S('WNID', DynamicEnvVariableFields.WORKER_NODE_ID),
                S('VOL', DynamicEnvVariableFields.VOLUME),
                S('DIR', DynamicEnvVariableFields.DIRECTORY, 's1', 'ls'),
                { projectId: 'p1', secretName: 'PLAIN', secretValue: 'literal', secretPlaceholder: '', variable: false },
            ],
        } as unknown as Project;
        const volPath = stringifyDynamicVariablePath('p1', undefined, undefined, DynamicEnvVariableFields.VOLUME);
        const dirPath = stringifyDynamicVariablePath('p1', 's1', 'ls', DynamicEnvVariableFields.DIRECTORY);
        const dotenv = await getDotenvForProject(project, [{ proxyLocationId: 'lp', port: 1234 }], { [volPath]: { fullPath: '/vol' }, [dirPath]: { fullPath: '/dir' } });
        const map = Object.fromEntries(dotenv.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
        expect(map).toMatchObject({ DOMAIN: 'ex.com', URL: 'https://ex.com/api', PATH: '/api', PORT: '1234', TARGET: 'https://t', WNID: 'n9', VOL: '/vol', DIR: '/dir', PLAIN: 'literal' });
    });
});
