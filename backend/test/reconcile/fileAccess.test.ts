import { describe, it, expect, beforeEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from '@/config';
import { FileAccessError, listDirectoryLocal, openFileStreamLocal, readFileLocal } from '@/reconcile/fileAccess';

const VOLUME = { kind: 'volume' as const };
const PROJECT = 'p1';
const OTHER = 'otherproject';

let volumeBase: string; // the project's own volume dir (the only thing that should be reachable)
let otherVolume: string; // a sibling project's volume (must never be reachable)

// Build a realistic on-disk layout under temp persistent/deployment roots before each test.
beforeEach(async () => {
    const persistent = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsm-persist-'));
    const deployment = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsm-deploy-'));
    config.persistentPath = persistent;
    config.deploymentPath = deployment;

    volumeBase = path.join(persistent, PROJECT, 'volume');
    otherVolume = path.join(persistent, OTHER, 'volume');
    await fsp.mkdir(path.join(volumeBase, 'sub'), { recursive: true });
    await fsp.mkdir(otherVolume, { recursive: true });

    await fsp.writeFile(path.join(volumeBase, 'inside.txt'), 'hello world\n');
    await fsp.writeFile(path.join(volumeBase, 'sub', 'inner.txt'), 'nested\n');
    await fsp.writeFile(path.join(otherVolume, 'secret.txt'), 'TOP SECRET from another project');

    // A binary file (contains a NUL byte) to exercise classification.
    await fsp.writeFile(path.join(volumeBase, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));

    // Symlinks: one escaping to another project's dir, one escaping to a file there, and one that
    // resolves back INSIDE the project. All must be rejected.
    await fsp.symlink(otherVolume, path.join(volumeBase, 'escape-dir'));
    await fsp.symlink(path.join(otherVolume, 'secret.txt'), path.join(volumeBase, 'escape-file'));
    await fsp.symlink(path.join(volumeBase, 'sub'), path.join(volumeBase, 'loopback'));
});

describe('fileAccess traversal + symlink containment', () => {
    it('lists only the project volume contents', async () => {
        const listing = await listDirectoryLocal(PROJECT, VOLUME, '');
        const names = listing.entries.map((e) => e.name).sort();
        expect(names).toContain('inside.txt');
        expect(names).toContain('sub');
        // Symlinks are listed (for visibility) but typed as symlink.
        const escape = listing.entries.find((e) => e.name === 'escape-dir');
        expect(escape?.type).toBe('symlink');
        const loopback = listing.entries.find((e) => e.name === 'loopback');
        expect(loopback?.type).toBe('symlink');
    });

    it('reads a normal text file as text', async () => {
        const file = await readFileLocal(PROJECT, VOLUME, 'inside.txt');
        expect(file.fileClass).toBe('text');
        expect(file.text).toBe('hello world\n');
        expect(file.previewAvailable).toBe(true);
    });

    it('classifies a NUL-containing file as binary with no preview', async () => {
        const file = await readFileLocal(PROJECT, VOLUME, 'blob.bin');
        expect(file.fileClass).toBe('binary');
        expect(file.previewAvailable).toBe(false);
        expect(file.text).toBeUndefined();
    });

    it('neutralizes ../ traversal to a sibling project (empty, not an escape)', async () => {
        const listing = await listDirectoryLocal(PROJECT, VOLUME, '../otherproject/volume');
        expect(listing.entries).toEqual([]); // resolves inside base to a non-existent path
    });

    it('does not read another project file via ../ traversal', async () => {
        await expect(readFileLocal(PROJECT, VOLUME, '../otherproject/volume/secret.txt')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('neutralizes an absolute path by confining it to the base', async () => {
        await expect(readFileLocal(PROJECT, VOLUME, '/etc/passwd')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('rejects navigating a symlink that escapes to another project', async () => {
        await expect(listDirectoryLocal(PROJECT, VOLUME, 'escape-dir')).rejects.toBeInstanceOf(FileAccessError);
        await expect(listDirectoryLocal(PROJECT, VOLUME, 'escape-dir')).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('rejects reading a file through an escaping symlink', async () => {
        await expect(readFileLocal(PROJECT, VOLUME, 'escape-file')).rejects.toMatchObject({ code: 'forbidden' });
        await expect(readFileLocal(PROJECT, VOLUME, 'escape-dir/secret.txt')).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('rejects a symlink even when it resolves back inside the project', async () => {
        await expect(listDirectoryLocal(PROJECT, VOLUME, 'loopback')).rejects.toMatchObject({ code: 'forbidden' });
        await expect(readFileLocal(PROJECT, VOLUME, 'loopback/inner.txt')).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('opens a bounded raw stream for a real file and rejects symlink escapes', async () => {
        const raw = await openFileStreamLocal(PROJECT, VOLUME, 'inside.txt');
        expect(raw.size).toBe('hello world\n'.length);
        raw.stream.destroy();
        await expect(openFileStreamLocal(PROJECT, VOLUME, 'escape-file')).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('returns an empty listing for a not-yet-created base dir', async () => {
        const listing = await listDirectoryLocal('never-deployed', VOLUME, '');
        expect(listing.entries).toEqual([]);
        expect(listing.truncated).toBe(false);
    });
});
