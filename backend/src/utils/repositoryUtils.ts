import { execSafe } from '@/host/exec';
import * as fs from 'fs/promises';
import { getGitHttpsUri, getGitSshUri } from '@mosaiq/nsm-common/gitUtils';
import YAML from 'yaml';
import { DockerCompose } from '@mosaiq/nsm-common/dockerComposeTypes';
import { config, gitSshKeyPath, isGithubAppConfigured } from '@/config';
import { getCloneToken, withCloneCredentials } from '@/utils/githubApp';

export interface RepoData {
    dotenv: string;
    compose: { exists: boolean; contents: string; parsed: DockerCompose | undefined };
    jsEnvVars: string[];
}

export const getRepoData = async (projectId: string, repoOwner: string, repoName: string, repoBranch: string | undefined): Promise<RepoData> => {
    await cloneRepository(projectId, repoOwner, repoName, repoBranch);
    const dir = `${config.repoSandboxPath}/${projectId}`;
    const envFileContents = await getEnvFileFromDir(dir);
    const dockerComposeFile = await getDockerComposeFileFromDir(dir);
    const jsEnvVars = await getJsProcessEnvVarsFromDir(dir);
    await deleteSandboxRepo(projectId);
    return {
        dotenv: envFileContents,
        compose: dockerComposeFile,
        jsEnvVars,
    };
};

const getEnvFileFromDir = async (dir: string): Promise<string> => {
    let envFile = '';
    try {
        const files = await fs.readdir(dir);
        envFile = files.filter((file) => file.startsWith('.env'))[0] || '';
    } catch (error) {
        console.error('Error reading directory:', error);
        return '';
    }
    if (!envFile) {
        console.warn('No .env file found in repository');
        return '';
    }
    try {
        const envFileContents = await fs.readFile(`${dir}/${envFile}`, 'utf-8');
        return envFileContents;
    } catch (error) {
        console.error('Error reading .env file:', error, dir, envFile);
        return '';
    }
};

const getDockerComposeFileFromDir = async (dir: string): Promise<{ exists: boolean; contents: string; parsed: DockerCompose | undefined }> => {
    const dockerComposeFilenames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

    for (const filename of dockerComposeFilenames) {
        try {
            const contents = await fs.readFile(`${dir}/${filename}`, 'utf-8');
            const parsed = YAML.parse(contents) as DockerCompose;
            return { exists: true, contents, parsed };
        } catch {
            // File not found, continue to next
        }
    }
    console.warn('No Docker Compose file found in repository');
    return { exists: false, contents: '', parsed: undefined };
};

export const buildDockerComposeString = (compose: DockerCompose): string => {
    return YAML.stringify(compose);
};

// True when a compose `ports` short-syntax string pins a literal host port (e.g. "8080:3000" or
// "127.0.0.1:8080:3000"), which would collide between two coexisting generations. A published side
// driven by an env var (e.g. "${PORT}:3000") or a container-only spec (e.g. "3000") does not.
const stringPortPinsHostPort = (spec: string): boolean => {
    const body = spec.trim().replace(/\/(tcp|udp)$/i, '');
    const parts = body.split(':');
    if (parts.length < 2) return false; // container-only, ephemeral host port
    const published = parts.slice(0, -1).join(':');
    if (published.includes('${')) return false; // NSM-injected/env-driven host port
    return /\d/.test(published);
};

const looksLikeNamedVolume = (source: string): boolean => {
    const s = source.trim();
    if (!s) return false;
    if (s.includes('${')) return false; // resolved from a dynamic var (NSM bind path)
    return !/^(\/|\.\/|\.\.\/|~)/.test(s); // absolute or relative path => bind mount, else named
};

// Rewrites a managed compose so two generations can run side by side during a zero-downtime deploy.
// Generation-scoped compose project names rename default containers/networks/volumes, but a compose
// that pins `container_name` or a fixed host port would still collide; strip those. Named volumes
// only get a warning: the generation-scoped project name gives them a fresh namespace, so state must
// live in bind-mounted/external volumes instead. Mutates and returns `compose`, plus human-readable
// warnings to surface in the deploy log.
export const sanitizeComposeForCoexistence = (compose: DockerCompose): { compose: DockerCompose; warnings: string[] } => {
    const warnings: string[] = [];
    for (const [name, svc] of Object.entries(compose.services || {})) {
        if (!svc) continue;
        if (svc.container_name) {
            warnings.push(`service "${name}": removed hardcoded container_name "${svc.container_name}" (collides across generations under zero-downtime).`);
            delete svc.container_name;
        }
        if (Array.isArray(svc.ports) && svc.ports.length) {
            const kept: typeof svc.ports = [] as any;
            for (const p of svc.ports) {
                if (typeof p === 'string') {
                    if (stringPortPinsHostPort(p)) {
                        warnings.push(`service "${name}": dropped fixed host port mapping "${p}" (would collide across generations); publish via the NSM-injected port variable instead.`);
                        continue;
                    }
                    (kept as string[]).push(p);
                } else if (p && typeof p === 'object') {
                    const published = p.published ? String(p.published) : '';
                    if (published && !published.includes('${') && /\d/.test(published)) {
                        warnings.push(`service "${name}": dropped fixed host port mapping "${published}" (would collide across generations); publish via the NSM-injected port variable instead.`);
                        continue;
                    }
                    (kept as any[]).push(p);
                }
            }
            svc.ports = kept.length ? kept : undefined;
        }
        const vols = svc.volumes;
        const volList = Array.isArray(vols) ? vols : vols ? [vols] : [];
        for (const v of volList) {
            const source = typeof v === 'string' ? v.split(':')[0] : (v as any)?.type === 'volume' ? (v as any).source : '';
            if (source && looksLikeNamedVolume(source)) {
                warnings.push(`service "${name}": named volume "${source}" starts empty each deploy under zero-downtime; use a bind-mounted or external volume for persistent state.`);
            }
        }
    }
    return { compose, warnings };
};

const getJsProcessEnvVarsFromDir = async (dir: string): Promise<string[]> => {
    const jsFileExtensions = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
    const ignoreDirs = ['node_modules', '.git', '.github', '.vscode'];
    const jsFiles: string[] = [];

    const walkDir = async (currentDir: string) => {
        if (ignoreDirs.some((d) => currentDir.includes(`/${d}`))) return;
        const files = await fs.readdir(currentDir);
        for (const file of files) {
            const fullPath = `${currentDir}/${file}`;
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                await walkDir(fullPath);
            } else if (jsFileExtensions.some((ext) => file.endsWith(ext))) {
                jsFiles.push(fullPath);
            }
        }
    };
    await walkDir(dir);

    const envVars = new Set<string>();
    const envVarRegex = /process\.env\.([A-Za-z0-9_-]+)/g;
    for (const file of jsFiles) {
        try {
            const contents = await fs.readFile(file, 'utf-8');
            const matches = contents.matchAll(envVarRegex);
            for (const match of matches) {
                if (match[1]) {
                    envVars.add(match[1]);
                }
            }
        } catch (error) {
            console.error('Error reading JS file:', error, file);
        }
    }
    return Array.from(envVars);
};

const deleteSandboxRepo = async (projectId: string): Promise<void> => {
    try {
        await fs.rm(`${config.repoSandboxPath}/${projectId}`, { recursive: true, force: true });
    } catch (e: any) {
        console.error('Error removing directory:', e);
        return;
    }
};

const cloneRepository = async (projectId: string, repoOwner: string, repoName: string, repoBranch: string | undefined): Promise<void> => {
    const repoPath = `${config.repoSandboxPath}/${projectId}`;
    const branchFlags = repoBranch ? `-b ${repoBranch} --single-branch` : '';

    await deleteSandboxRepo(projectId);

    if (!config.production) {
        console.log('Not in production mode, handling local repository clone');
        const httpUri = getGitHttpsUri(repoOwner, repoName);
        const cmd = `git clone --progress ${branchFlags} ${httpUri} ${repoPath}`;
        console.log('Cloning repository with command:', cmd);
        const { out: gitOut, code: gitCode } = await execSafe(cmd, 1000 * 60 * 1);
        console.error('Git clone output:', gitOut);
        if (gitCode !== 0) {
            throw new Error(`Git clone exited with code ${gitCode}`);
        }

        return;
    }

    try {
        // Preferred: GitHub App installation token over HTTPS (no machine user, per-repo, short-lived).
        if (isGithubAppConfigured()) {
            const httpsUri = getGitHttpsUri(repoOwner, repoName);
            const { token } = await getCloneToken(repoOwner, repoName);
            const { out: gitOut, code: gitCode } = await withCloneCredentials(token, (envPrefix) =>
                execSafe(`${envPrefix} git clone --progress ${branchFlags} ${httpsUri} ${repoPath}`, 1000 * 60 * 5)
            );
            if (gitCode !== 0) {
                console.error('Git clone output:', gitOut);
                throw new Error(`Git clone exited with code ${gitCode}`);
            }
            return;
        }

        // Fallback: shared SSH deploy key.
        const gitSshUri = getGitSshUri(repoOwner, repoName);
        const sshFlags = `-c core.sshCommand="/usr/bin/ssh -i ${gitSshKeyPath()}"`;
        const cmd = `git clone --progress ${branchFlags} ${sshFlags} ${gitSshUri} ${repoPath}`;
        const { out: gitOut, code: gitCode } = await execSafe(cmd, 1000 * 60 * 5);
        if (gitCode !== 0) {
            console.error('Git clone output:', gitOut);
            throw new Error(`Git clone exited with code ${gitCode}`);
        }
        return;
    } catch (e: any) {
        console.error('Error cloning repository:', e);
        throw e;
    }
};

export const getServicesForProject = (compose: DockerCompose | undefined): string[] => {
    if (!compose || !compose.services) return [];
    return Object.keys(compose.services);
};
