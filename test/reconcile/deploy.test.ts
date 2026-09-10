import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';

vi.mock('@/host/exec', () => ({
    execSafe: vi.fn(async (cmd: string) => {
        if (cmd.startsWith('git clone')) {
            const parts = cmd.trim().split(/\s+/);
            await fsp.mkdir(parts[parts.length - 1], { recursive: true });
        }
        return { out: '', code: 0 };
    }),
    execStream: vi.fn(async () => ({ out: '', code: 0 })),
}));
vi.mock('@/reconcile/report', () => ({ reportDeploymentLog: vi.fn() }));
vi.mock('@/reconcile/state', () => ({ setLocalGeneration: vi.fn() }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { applyDeployment } from '@/reconcile/deploy';
import { reportDeploymentLog } from '@/reconcile/report';
import { setLocalGeneration } from '@/reconcile/state';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';

const mockStream = execStream as unknown as Mock;
const mockReport = reportDeploymentLog as unknown as Mock;
const mockSetGen = setLocalGeneration as unknown as Mock;

const dep = (over: Partial<DesiredDeployment> = {}): DesiredDeployment => ({ projectId: 'proj1', generation: 3, assignedNodeId: 'n1', repoOwner: 'o', repoName: 'r', timeout: 60000, logId: 'log1', dotenv: 'FOO=bar', compose: 'services:\n  web: {}', nginxConf: '# conf', domains: ['a.com'], services: [], ...over });

beforeEach(() => {
    config.production = true;
    mockStream.mockClear();
    mockReport.mockClear();
    mockSetGen.mockClear();
});
afterEach(() => {
    config.production = false;
});

const lastReportStates = () => mockReport.mock.calls.map((c) => c[1]);

describe('applyDeployment', () => {
    it('clones, injects compose+dotenv, runs compose up, writes generation, reports DEPLOYED', async () => {
        const d = dep();
        await applyDeployment(d);
        const repoPath = `${config.deploymentPath}/${d.projectId}`;
        expect(await fsp.readFile(`${repoPath}/docker-compose.yml`, 'utf-8')).toContain('services:');
        expect(await fsp.readFile(`${repoPath}/.env`, 'utf-8')).toContain('FOO=bar');
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('docker compose -p proj1 up --build -d'), d.timeout, expect.any(Function));
        expect(mockSetGen).toHaveBeenCalledWith('proj1', 3);
        expect(lastReportStates()).toContain(DeploymentState.DEPLOYED);
        expect(lastReportStates()).not.toContain(DeploymentState.FAILED);
    });

    it('reports FAILED and skips the generation marker when compose up fails', async () => {
        mockStream.mockResolvedValueOnce({ out: 'compose error', code: 1 });
        await applyDeployment(dep());
        expect(lastReportStates()).toContain(DeploymentState.FAILED);
        expect(mockSetGen).not.toHaveBeenCalled();
    });

    it('skips file injection and compose up in non-production but still marks generation', async () => {
        config.production = false;
        const d = dep();
        await applyDeployment(d);
        expect(mockStream).not.toHaveBeenCalled();
        await expect(fsp.readFile(`${config.deploymentPath}/${d.projectId}/docker-compose.yml`, 'utf-8')).rejects.toBeTruthy();
        expect(mockSetGen).toHaveBeenCalledWith('proj1', 3);
        expect(lastReportStates()).toContain(DeploymentState.DEPLOYED);
    });
});
