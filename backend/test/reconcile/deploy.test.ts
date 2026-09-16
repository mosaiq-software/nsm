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
vi.mock('@/reconcile/report', () => ({ reportDeploymentLog: vi.fn(), reportDeployReady: vi.fn() }));
vi.mock('@/reconcile/state', () => ({
    setLocalGeneration: vi.fn(),
    markGenerationLive: vi.fn(),
    markGenerationReady: vi.fn(),
    removeLiveGeneration: vi.fn(),
}));
vi.mock('@/reconcile/ports', () => ({ releasePorts: vi.fn(), waitPortReady: vi.fn(async () => true) }));
vi.mock('@/reconcile/teardown', () => ({ teardownGenerationLocal: vi.fn() }));

import { config } from '@/config';
import { execStream } from '@/host/exec';
import { applyDeployment } from '@/reconcile/deploy';
import { reportDeploymentLog, reportDeployReady } from '@/reconcile/report';
import { setLocalGeneration, markGenerationLive, markGenerationReady } from '@/reconcile/state';
import { waitPortReady } from '@/reconcile/ports';
import { teardownGenerationLocal } from '@/reconcile/teardown';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';

const mockStream = execStream as unknown as Mock;
const mockReport = reportDeploymentLog as unknown as Mock;
const mockReady = reportDeployReady as unknown as Mock;
const mockSetGen = setLocalGeneration as unknown as Mock;
const mockLive = markGenerationLive as unknown as Mock;
const mockReadyGen = markGenerationReady as unknown as Mock;
const mockWaitPort = waitPortReady as unknown as Mock;
const mockGenTeardown = teardownGenerationLocal as unknown as Mock;

const dep = (over: Partial<DesiredDeployment> = {}): DesiredDeployment => ({ projectId: 'proj1', generation: 3, assignedNodeId: 'n1', repoOwner: 'o', repoName: 'r', timeout: 60000, logId: 'log1', dotenv: 'FOO=bar', compose: 'services:\n  web: {}', nginxConf: '# conf', domains: ['a.com'], services: [], zeroDowntime: false, ports: [], ...over });

beforeEach(() => {
    config.production = true;
    vi.clearAllMocks();
    mockStream.mockResolvedValue({ out: '', code: 0 });
    mockWaitPort.mockResolvedValue(true);
});
afterEach(() => {
    config.production = false;
});

const lastReportStates = () => mockReport.mock.calls.map((c) => c[1]);

describe('applyDeployment (legacy in-place)', () => {
    it('clones, injects compose+dotenv, runs compose up in place, writes generation, reports DEPLOYED', async () => {
        const d = dep();
        await applyDeployment(d);
        const repoPath = `${config.deploymentPath}/${d.projectId}`;
        expect(await fsp.readFile(`${repoPath}/docker-compose.yml`, 'utf-8')).toContain('services:');
        expect(await fsp.readFile(`${repoPath}/.env`, 'utf-8')).toContain('FOO=bar');
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('docker compose -p proj1 up --build -d'), d.timeout, expect.any(Function), expect.any(Object));
        expect(mockSetGen).toHaveBeenCalledWith('proj1', 3);
        expect(mockReady).not.toHaveBeenCalled();
        expect(lastReportStates()).toContain(DeploymentState.DEPLOYED);
        expect(lastReportStates()).not.toContain(DeploymentState.FAILED);
    });

    it('runs compose up with an isolated env that omits NSM secrets but keeps PATH', async () => {
        await applyDeployment(dep());
        const call = mockStream.mock.calls.find((c) => String(c[0]).includes('up --build'));
        expect(call).toBeTruthy();
        const env = call![3] as NodeJS.ProcessEnv;
        expect(env.CLUSTER_SECRET).toBeUndefined();
        expect(env.PATH).toBe(process.env.PATH);
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

describe('applyDeployment (zero-downtime / blue-green)', () => {
    it('brings up a generation-scoped stack in a per-generation workdir, gates readiness, and reports ready', async () => {
        const d = dep({ zeroDowntime: true, ports: [{ proxyLocationId: 'lp', port: 1234 }] });
        const ok = await applyDeployment(d);
        expect(ok).toBe(true);
        const genPath = `${config.deploymentPath}/proj1/g3`;
        expect(await fsp.readFile(`${genPath}/docker-compose.yml`, 'utf-8')).toContain('services:');
        // Blue-green project name coexists with the old generation; runs from the per-gen workdir.
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining('docker compose -p proj1-g3 up --build -d'), d.timeout, expect.any(Function), expect.any(Object));
        expect(mockStream).toHaveBeenCalledWith(expect.stringContaining(genPath), d.timeout, expect.any(Function), expect.any(Object));
        expect(mockLive).toHaveBeenCalledWith('proj1', 3);
        expect(mockWaitPort).toHaveBeenCalledWith(1234, expect.any(Number), undefined);
        expect(mockReadyGen).toHaveBeenCalledWith('proj1', 3);
        expect(mockReady).toHaveBeenCalledWith('proj1', 3, expect.any(String));
        // Legacy single-generation marker is NOT used on the blue-green path.
        expect(mockSetGen).not.toHaveBeenCalled();
    });

    it('fails, tears down the blue stack, and does NOT report ready when the readiness gate fails', async () => {
        mockWaitPort.mockResolvedValue(false);
        const d = dep({ zeroDowntime: true, ports: [{ proxyLocationId: 'lp', port: 1234 }] });
        const ok = await applyDeployment(d);
        expect(ok).toBe(false);
        expect(mockReady).not.toHaveBeenCalled();
        expect(mockReadyGen).not.toHaveBeenCalled();
        expect(mockGenTeardown).toHaveBeenCalledWith('proj1', 3);
        expect(lastReportStates()).toContain(DeploymentState.FAILED);
    });
});
