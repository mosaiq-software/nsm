import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('@/host/exec', () => ({ execSafe: vi.fn(async () => ({ out: '', code: 0 })), execStream: vi.fn(async () => ({ out: '', code: 0 })) }));

import { config } from '@/config';
import { execSafe, execStream } from '@/host/exec';
import { teardownProjectLocal, teardownGenerationLocal, archivePersistentDirLocal, purgeProjectLocal } from '@/reconcile/teardown';

const mockStream = execStream as unknown as Mock;
const mockSafe = execSafe as unknown as Mock;

beforeEach(() => {
    config.production = true;
    mockStream.mockClear();
    mockSafe.mockReset().mockResolvedValue({ out: '', code: 0 });
});
afterEach(() => {
    config.production = false;
});

describe('teardownProjectLocal', () => {
    it('runs compose down and the global prune in production', async () => {
        await teardownProjectLocal('proj1');
        expect(mockStream).toHaveBeenCalledTimes(1);
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker system prune -af');
    });

    it('tears down every generation of the project (exact match, no prefix cross-match)', async () => {
        mockSafe.mockImplementation(async (cmd: string) => {
            if (cmd.includes('docker compose ls')) {
                return { out: JSON.stringify([{ Name: 'proj1' }, { Name: 'proj1-g1' }, { Name: 'proj1-g2' }, { Name: 'proj12' }, { Name: 'proj12-g1' }]), code: 0 };
            }
            return { out: '', code: 0 };
        });
        await teardownProjectLocal('proj1');
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker compose -p proj1-g1 down');
        expect(cmd).toContain('docker compose -p proj1-g2 down');
        expect(cmd).toContain('docker system prune -af');
        // "proj12"/"proj12-g1" must NOT be swept up by "proj1".
        expect(cmd).not.toContain('docker compose -p proj12 down');
        expect(cmd).not.toContain('docker compose -p proj12-g1 down');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await teardownProjectLocal('proj1');
        expect(mockStream).not.toHaveBeenCalled();
    });
});

describe('teardownGenerationLocal', () => {
    it('downs a single generation-scoped project and never runs the global prune', async () => {
        await teardownGenerationLocal('proj1', 2);
        expect(mockStream).toHaveBeenCalledTimes(1);
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1-g2 down');
        expect(cmd).not.toContain('docker system prune');
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await teardownGenerationLocal('proj1', 2);
        expect(mockStream).not.toHaveBeenCalled();
    });
});

describe('archivePersistentDirLocal', () => {
    let tmpDir: string;
    let prevPersistent: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsm-persist-'));
        prevPersistent = config.persistentPath;
        config.persistentPath = tmpDir;
    });
    afterEach(async () => {
        config.persistentPath = prevPersistent;
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('renames the persistent dir to <projectId>-deleted-<uuid> and preserves its contents', async () => {
        const src = path.join(tmpDir, 'proj1');
        await fsp.mkdir(path.join(src, 'volume'), { recursive: true });
        await fsp.writeFile(path.join(src, 'volume', 'data.txt'), 'keep me');

        await archivePersistentDirLocal('proj1');

        expect(await fsp.readdir(tmpDir)).not.toContain('proj1');
        const archived = (await fsp.readdir(tmpDir)).find((n) => n.startsWith('proj1-deleted-'));
        expect(archived).toBeTruthy();
        const uuid = archived!.replace('proj1-deleted-', '');
        expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
        expect(await fsp.readFile(path.join(tmpDir, archived!, 'volume', 'data.txt'), 'utf-8')).toBe('keep me');
    });

    it('does not cross-match a sibling project whose id is a prefix', async () => {
        await fsp.mkdir(path.join(tmpDir, 'proj1'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'proj12'), { recursive: true });
        await archivePersistentDirLocal('proj1');
        expect(await fsp.readdir(tmpDir)).toContain('proj12');
    });

    it('is a no-op when the persistent dir is missing', async () => {
        await expect(archivePersistentDirLocal('nope')).resolves.toBeUndefined();
        expect(await fsp.readdir(tmpDir)).toHaveLength(0);
    });

    it('is a no-op in non-production', async () => {
        config.production = false;
        await fsp.mkdir(path.join(tmpDir, 'proj1'), { recursive: true });
        await archivePersistentDirLocal('proj1');
        expect(await fsp.readdir(tmpDir)).toContain('proj1');
    });
});

describe('purgeProjectLocal', () => {
    let tmpDir: string;
    let prevPersistent: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsm-persist-'));
        prevPersistent = config.persistentPath;
        config.persistentPath = tmpDir;
    });
    afterEach(async () => {
        config.persistentPath = prevPersistent;
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('tears down containers/deploy dir then archives the persistent dir', async () => {
        await fsp.mkdir(path.join(tmpDir, 'proj1'), { recursive: true });
        await purgeProjectLocal('proj1');
        // teardownProjectLocal ran its compose down + prune.
        const cmd = mockStream.mock.calls[0][0] as string;
        expect(cmd).toContain('docker compose -p proj1 down');
        expect(cmd).toContain('docker system prune -af');
        // persistent dir archived.
        expect(await fsp.readdir(tmpDir)).not.toContain('proj1');
        expect((await fsp.readdir(tmpDir)).some((n) => n.startsWith('proj1-deleted-'))).toBe(true);
    });
});
