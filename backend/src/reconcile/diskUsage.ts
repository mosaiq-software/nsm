import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { NodeFilesystemUsage, NodeStorageSpec, ProjectDiskUsage } from '@mosaiq/nsm-common/types';
import { config } from '@/config';
import { listLocalProjects } from './state';
import { projectDiskUsageBytes } from '@/utils/metrics';
import { areaLog } from '@/utils/log';

const execFileAsync = promisify(execFile);
const diskLog = areaLog('diskUsage');

// Pseudo/virtual filesystems that don't represent real storage; excluded from the per-drive view.
const PSEUDO_FSTYPES = new Set([
    'tmpfs',
    'devtmpfs',
    'proc',
    'sysfs',
    'cgroup',
    'cgroup2',
    'overlay',
    'squashfs',
    'devpts',
    'mqueue',
    'debugfs',
    'tracefs',
    'securityfs',
    'pstore',
    'bpf',
    'autofs',
    'configfs',
    'ramfs',
    'hugetlbfs',
    'fusectl',
    'binfmt_misc',
    'nsfs',
    'rpc_pipefs',
]);

interface MountEntry {
    device: string;
    mountpoint: string;
    fstype: string;
}

// /proc/mounts octal-escapes spaces/tabs/newlines/backslashes in device and mountpoint fields.
const unescapeMount = (s: string): string => s.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');

const readMounts = async (): Promise<MountEntry[]> => {
    const raw = await fs.readFile('/proc/mounts', 'utf-8');
    const entries: MountEntry[] = [];
    for (const line of raw.split('\n')) {
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;
        entries.push({ device: unescapeMount(parts[0]), mountpoint: unescapeMount(parts[1]), fstype: parts[2] });
    }
    return entries;
};

// The filesystem a path lives on: the mount whose mountpoint is the longest prefix of the path.
const mountForPath = (path: string, mounts: MountEntry[]): MountEntry | undefined => {
    let best: MountEntry | undefined;
    for (const m of mounts) {
        const prefix = m.mountpoint === '/' ? '/' : `${m.mountpoint}/`;
        if (path === m.mountpoint || path.startsWith(prefix)) {
            if (!best || m.mountpoint.length > best.mountpoint.length) best = m;
        }
    }
    return best;
};

// Bytes used by a directory subtree. `-x` stays on one filesystem so a nested mount isn't counted
// against the parent; missing paths (not yet created) count as 0.
const dirSizeBytes = async (path: string): Promise<number> => {
    try {
        await fs.access(path);
    } catch {
        return 0;
    }
    try {
        const { stdout } = await execFileAsync('du', ['-sxb', path], { maxBuffer: 8 * 1024 * 1024 });
        const n = parseInt(stdout.split(/\s+/)[0], 10);
        return Number.isFinite(n) ? n : 0;
    } catch (e: any) {
        diskLog.warn({ action: 'du_failed', path, err: e?.message }, `du failed for ${path}`);
        return 0;
    }
};

// Size/used/available for every real (non-pseudo, block-device-backed) filesystem on this host.
const collectFilesystems = async (mounts: MountEntry[]): Promise<NodeFilesystemUsage[]> => {
    const seen = new Set<string>();
    const out: NodeFilesystemUsage[] = [];
    for (const m of mounts) {
        if (PSEUDO_FSTYPES.has(m.fstype)) continue;
        if (!m.device.startsWith('/dev/')) continue;
        if (seen.has(m.mountpoint)) continue;
        seen.add(m.mountpoint);
        try {
            const st = await fs.statfs(m.mountpoint);
            const bsize = Number(st.bsize);
            const sizeBytes = Number(st.blocks) * bsize;
            const availBytes = Number(st.bavail) * bsize;
            const freeBytes = Number(st.bfree) * bsize;
            out.push({ device: m.device, mountpoint: m.mountpoint, fstype: m.fstype, sizeBytes, usedBytes: Math.max(0, sizeBytes - freeBytes), availBytes });
        } catch (e: any) {
            diskLog.warn({ action: 'statfs_failed', mountpoint: m.mountpoint, err: e?.message }, `statfs failed for ${m.mountpoint}`);
        }
    }
    return out;
};

// Measure this node's per-project disk usage (volume vs deployed code, per filesystem), publish it
// to the Prometheus gauge for time-series history, and return the full storage spec for the caller.
// Runs on a 30-minute cron and on demand via the snapshot RPC. Dev-guarded like other reconcile code.
export const collectDiskUsage = async (): Promise<NodeStorageSpec> => {
    const capturedAt = Date.now();
    if (!config.production) {
        return { nodeId: config.nodeId, capturedAt, filesystems: [], projects: [] };
    }

    const started = Date.now();
    const [projects, mounts] = await Promise.all([listLocalProjects(), readMounts()]);
    const filesystems = await collectFilesystems(mounts);

    // Rebuild the gauge from scratch so torn-down projects don't leave stale series behind.
    projectDiskUsageBytes.reset();

    const byKey = new Map<string, ProjectDiskUsage>();
    const record = (projectId: string, kind: 'volume' | 'code', bytes: number, mount: MountEntry | undefined): void => {
        const device = mount?.device ?? 'unknown';
        const mountpoint = mount?.mountpoint ?? 'unknown';
        projectDiskUsageBytes.set({ projectId, kind, device, mountpoint }, bytes);
        const key = `${projectId}|${device}|${mountpoint}`;
        const entry = byKey.get(key) ?? { projectId, device, mountpoint, volumeBytes: 0, codeBytes: 0, totalBytes: 0 };
        if (kind === 'volume') entry.volumeBytes += bytes;
        else entry.codeBytes += bytes;
        entry.totalBytes = entry.volumeBytes + entry.codeBytes;
        byKey.set(key, entry);
    };

    for (const projectId of projects) {
        const volumePath = `${config.persistentPath}/${projectId}/volume`;
        const codePath = `${config.deploymentPath}/${projectId}`;
        const [volumeBytes, codeBytes] = await Promise.all([dirSizeBytes(volumePath), dirSizeBytes(codePath)]);
        record(projectId, 'volume', volumeBytes, mountForPath(volumePath, mounts));
        record(projectId, 'code', codeBytes, mountForPath(codePath, mounts));
    }

    const spec: NodeStorageSpec = { nodeId: config.nodeId, capturedAt, filesystems, projects: [...byKey.values()] };
    diskLog.info({ action: 'disk_usage_collected', projectCount: projects.length, filesystemCount: filesystems.length, durationMs: Date.now() - started }, `collected disk usage for ${projects.length} project(s)`);
    return spec;
};
