import * as fs from 'fs/promises';
import { composeChildEnv, config } from '@/config';
import { execSafe, execStream } from '@/host/exec';

const TEARDOWN_TIMEOUT_MS = 3 * 60 * 1000;

const baseDir = (projectId: string) => `${config.deploymentPath}/${projectId}`;
const genDir = (projectId: string, generation: number) => `${baseDir(projectId)}/g${generation}`;
const genProject = (projectId: string, generation: number) => `${projectId}-g${generation}`;
const persistentDir = (projectId: string) => `${config.persistentPath}/${projectId}`;

// Tears down a SINGLE generation's containers (used to drain the old generation after a zero-downtime
// cutover, or to clean up a failed blue stack). Deliberately does NOT run a global prune: another
// generation of this or another project may be live or mid-build.
export const teardownGenerationLocal = async (projectId: string, generation: number): Promise<void> => {
    if (!config.production) return;
    const dir = genDir(projectId, generation);
    const cmd = `(cd ${dir} 2>/dev/null; docker compose -p ${genProject(projectId, generation)} down)`;
    try {
        const { out, code } = await execStream(cmd, TEARDOWN_TIMEOUT_MS, undefined, composeChildEnv());
        if (code !== 0) console.warn(`Teardown for ${genProject(projectId, generation)} exited with code ${code}: ${out}`);
    } catch (e: any) {
        console.error(`Error running generation teardown for ${genProject(projectId, generation)}: ${e.message}`);
    }
    try {
        await fs.rm(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
};

// Enumerates the compose projects belonging to a project on this host: every generation-scoped name
// (<projectId>-g<n>) plus the bare <projectId> (legacy in-place). Exact-match by regex so a project
// id that is a prefix of another (e.g. "app" vs "app2") never cross-matches.
const listComposeProjectNames = async (projectId: string): Promise<string[]> => {
    const names = new Set<string>([projectId]);
    const genRe = new RegExp(`^${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-g\\d+$`);
    try {
        const r = await execSafe('docker compose ls --all --format json', 10000);
        if (r && r.code === 0 && r.out.trim()) {
            const parsed = JSON.parse(r.out.trim()) as { Name?: string }[];
            for (const entry of parsed) {
                if (entry?.Name && (entry.Name === projectId || genRe.test(entry.Name))) names.add(entry.Name);
            }
        }
    } catch {
        /* best-effort: fall back to the bare project name below */
    }
    return Array.from(names);
};

const dirForProjectName = (projectId: string, name: string): string => {
    const m = name.match(/-g(\d+)$/);
    return m ? genDir(projectId, parseInt(m[1], 10)) : baseDir(projectId);
};

// Full teardown of a project: down EVERY generation (and the legacy in-place project), then run the
// global prune once, then remove the whole project directory. This is the genuine "remove the
// project" path (not the rotation path), so the global prune lives here.
export const teardownProjectLocal = async (projectId: string): Promise<void> => {
    if (!config.production) return;
    const names = await listComposeProjectNames(projectId);
    const downs = names.map((name) => `(cd ${dirForProjectName(projectId, name)} 2>/dev/null; docker compose -p ${name} down)`).join(' ; ');
    const cmd = `${downs} ; docker system prune -af`;
    try {
        const { out, code } = await execStream(cmd, TEARDOWN_TIMEOUT_MS, undefined, composeChildEnv());
        if (code !== 0) console.warn(`Teardown for ${projectId} exited with code ${code}: ${out}`);
    } catch (e: any) {
        console.error(`Error running teardown command for ${projectId}: ${e.message}`);
    }
    try {
        await fs.rm(baseDir(projectId), { recursive: true, force: true });
    } catch {
        /* ignore */
    }
};

// Renames a project's persistent directory to an archived name instead of deleting it, so a
// deleted project's data survives as `<projectId>-deleted-<uuid>` under the persistent path. Only
// used on genuine deletion (never on reassignment, which reuses teardownProjectLocal alone).
export const archivePersistentDirLocal = async (projectId: string): Promise<void> => {
    if (!config.production) return;
    const src = persistentDir(projectId);
    const dst = `${src}-deleted-${crypto.randomUUID()}`;
    try {
        await fs.rename(src, dst);
    } catch {
        /* ignore: the persistent dir may not exist (project never deployed here) */
    }
};

// Deletion-only purge for a project: full container/deploy-dir teardown, then archive (rename) the
// persistent dir. Distinct from teardownProjectLocal, which is also hit on reassignment and must
// leave persistent data in place.
export const purgeProjectLocal = async (projectId: string): Promise<void> => {
    await teardownProjectLocal(projectId);
    await archivePersistentDirLocal(projectId);
};
