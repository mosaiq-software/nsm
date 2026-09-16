import { DeploymentState } from '@mosaiq/nsm-common/types';
import { DesiredDeployment } from '@mosaiq/nsm-common/clusterOps';
import { getGitHttpsUri, getGitSshUri } from '@mosaiq/nsm-common/gitUtils';
import * as fs from 'fs/promises';
import YAML from 'yaml';
import { composeChildEnv, config, gitSshKeyPath, isGithubAppConfigured } from '@/config';
import { getCloneToken, withCloneCredentials } from '@/utils/githubApp';
import { execSafe, execStream } from '@/host/exec';
import { reportDeploymentLog, reportDeployReady } from './report';
import { markGenerationLive, markGenerationReady, removeLiveGeneration, setLocalGeneration } from './state';
import { releasePorts, waitPortReady } from './ports';
import { teardownGenerationLocal } from './teardown';
import { deployLogger } from '@/utils/log';
import { deploysTotal, deployDuration, errorsTotal } from '@/utils/metrics';

// Compose project name for a deployment. Zero-downtime deploys are generation-scoped so the new
// (blue) generation can run alongside the old (green) one; the legacy in-place path keeps the bare
// projectId so it recreates containers in place.
export const composeProjectName = (dep: DesiredDeployment): string => (dep.zeroDowntime ? `${dep.projectId}-g${dep.generation}` : dep.projectId);

// Working directory a deployment is cloned into. Zero-downtime deploys get a per-generation dir so
// standing up the new generation never deletes the old generation's compose file (which its teardown
// still needs); the legacy path reuses the single per-project dir.
export const workdirFor = (dep: DesiredDeployment): string => (dep.zeroDowntime ? `${config.deploymentPath}/${dep.projectId}/g${dep.generation}` : `${config.deploymentPath}/${dep.projectId}`);

// Applies a fully-rendered DesiredDeployment on this host (clone, write files, docker compose up).
// For zero-downtime deploys it additionally runs a readiness gate and, on success, reports the
// generation ready to the leader (which then flips nginx). Returns true on success.
export const applyDeployment = async (dep: DesiredDeployment): Promise<boolean> => {
    const dlog = deployLogger(dep.projectId, dep.logId);
    const endTimer = deployDuration.startTimer();
    const zeroDowntime = !!dep.zeroDowntime;
    const allocatedPorts = (dep.ports || []).map((p) => p.port);
    try {
        dlog.info({ generation: dep.generation, zeroDowntime }, 'reconciling deployment');
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Reconciling ${dep.projectId} to generation ${dep.generation}${zeroDowntime ? ' (zero-downtime)' : ''}...\n`);
        await cloneRepository(dep);
        await injectCompose(dep);
        await injectDotenv(dep);
        await runDeploymentCommand(dep);

        if (zeroDowntime) {
            // Blue-green bookkeeping runs in dev too (host side effects are individually stubbed), so a
            // dev leader still promotes and renders the conf; the readiness gate is a no-op in dev.
            await markGenerationLive(dep.projectId, dep.generation);
            await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'New generation started; waiting for it to become ready...\n');
            const ready = await runReadinessGate(dep);
            if (!ready) throw new Error('New generation failed its readiness gate (healthcheck/port probe) within the timeout');
            releasePorts(allocatedPorts); // ports are now bound; free the plan-time reservation
            await markGenerationReady(dep.projectId, dep.generation);
            await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYED, 'New generation is ready; requesting traffic cutover.\n');
            await reportDeployReady(dep.projectId, dep.generation, config.nodeId);
        } else {
            await setLocalGeneration(dep.projectId, dep.generation);
            releasePorts(allocatedPorts);
            await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYED, 'Deployment steps completed successfully.\n');
        }
        deploysTotal.inc({ result: 'success' });
        dlog.info('deployment completed');
        return true;
    } catch (error: any) {
        await reportDeploymentLog(dep.logId, DeploymentState.FAILED, `Failed to deploy project: ${error.message}\n`);
        deploysTotal.inc({ result: 'failure' });
        errorsTotal.inc({ area: 'deploy' });
        dlog.error({ err: error?.message }, 'deployment failed');
        // Roll back the failed blue stack so it never lingers holding ports; the old generation is
        // untouched and keeps serving (automatic rollback). teardownGenerationLocal is a no-op in dev.
        if (zeroDowntime) {
            try {
                await teardownGenerationLocal(dep.projectId, dep.generation);
                await removeLiveGeneration(dep.projectId, dep.generation);
            } catch (e: any) {
                dlog.error({ err: e?.message }, 'failed to clean up failed blue stack');
            }
        }
        releasePorts(allocatedPorts);
        return false;
    } finally {
        endTimer();
    }
};

const cloneRepository = async (dep: DesiredDeployment): Promise<void> => {
    const repoPath = workdirFor(dep);
    const branchFlags = dep.repoBranch ? `-b ${dep.repoBranch} --single-branch` : '';
    try {
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'Cleaning up old repository...\n');
        await fs.rm(repoPath, { recursive: true, force: true });
    } catch (e: any) {
        throw new Error(`Error cleaning up old repository: ${e.message}`);
    }

    if (!config.production) {
        const httpUri = getGitHttpsUri(dep.repoOwner, dep.repoName);
        const cmd = `git clone ${branchFlags} ${httpUri} ${repoPath}`;
        const { out, code } = await execSafe(cmd, 1000 * 60);
        if (code !== 0) throw new Error(`Git clone exited with code ${code}: ${out}`);
        return;
    }

    // Preferred: GitHub App installation token over HTTPS (no machine user, per-repo, short-lived).
    if (isGithubAppConfigured()) {
        const httpsUri = getGitHttpsUri(dep.repoOwner, dep.repoName);
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Cloning repository ${httpsUri}...\n`);
        const { token } = await getCloneToken(dep.repoOwner, dep.repoName);
        const { out, code } = await withCloneCredentials(token, (envPrefix) =>
            execSafe(`${envPrefix} git clone --progress ${branchFlags} ${httpsUri} ${repoPath}`, 1000 * 60 * 5)
        );
        if (code !== 0) throw new Error(`Git clone exited with code ${code}: ${out}`);
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Git clone output:\n${out}\n`);
        return;
    }

    // Fallback: shared SSH deploy key.
    const gitSshUri = getGitSshUri(dep.repoOwner, dep.repoName);
    const sshFlags = `-c core.sshCommand="/usr/bin/ssh -i ${gitSshKeyPath()}"`;
    const cmd = `git clone --progress ${branchFlags} ${sshFlags} ${gitSshUri} ${repoPath}`;
    await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Cloning repository ${gitSshUri}...\n`);
    const { out, code } = await execSafe(cmd, 1000 * 60 * 5);
    if (code !== 0) throw new Error(`Git clone exited with code ${code}: ${out}`);
    await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Git clone output:\n${out}\n`);
};

const injectDotenv = async (dep: DesiredDeployment): Promise<void> => {
    if (!config.production) return;
    try {
        const contents = `# Generated by NSM - Do not edit directly\n${dep.dotenv}`;
        await fs.writeFile(`${workdirFor(dep)}/.env`, contents);
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'Successfully injected dotenv file\n');
    } catch (e: any) {
        throw new Error(`Error injecting dotenv file: ${e.message}`);
    }
};

const injectCompose = async (dep: DesiredDeployment): Promise<void> => {
    if (!config.production) return;
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
    for (const file of composeFiles) {
        try {
            await fs.rm(`${workdirFor(dep)}/${file}`, { force: true, recursive: true });
        } catch {
            /* ignore */
        }
    }
    try {
        const contents = `# Generated by NSM - Do not edit directly\n${dep.compose}`;
        await fs.writeFile(`${workdirFor(dep)}/${composeFiles[0]}`, contents);
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'Successfully injected compose file\n');
    } catch (e: any) {
        throw new Error(`Error injecting compose file: ${e.message}`);
    }
};

const runDeploymentCommand = async (dep: DesiredDeployment): Promise<void> => {
    if (!config.production) return;
    const runCommand = `docker compose -p ${composeProjectName(dep)} up --build -d`;
    const deploymentCommand = `(cd ${workdirFor(dep)} && ${runCommand})`;
    const { out, code } = await execStream(
        deploymentCommand,
        dep.timeout,
        (data) => {
            void reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, data);
        },
        composeChildEnv()
    );
    if (code !== 0) throw new Error(`Deployment command exited with code ${code}: ${out}`);
    await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'Deployment command completed successfully.\n');
};

// === Readiness gate ===
// Combines two signals ("both" strategy): for services that declare a Docker HEALTHCHECK, poll their
// health until healthy; for every newly allocated proxy port, wait until it is listening (optionally
// answering an HTTP readiness path). Bounded by config.readinessTimeoutMs.
const runReadinessGate = async (dep: DesiredDeployment): Promise<boolean> => {
    if (!config.production) return true;
    const deadline = Date.now() + config.readinessTimeoutMs;

    const healthy = await waitForComposeHealthy(dep, deadline);
    if (!healthy) {
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, 'Readiness gate: container healthchecks did not pass in time.\n');
        return false;
    }

    for (const p of dep.ports || []) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const ok = await waitPortReady(p.port, remaining, p.readinessPath);
        if (!ok) {
            await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Readiness gate: port ${p.port} did not become ready in time.\n`);
            return false;
        }
        await reportDeploymentLog(dep.logId, DeploymentState.DEPLOYING, `Readiness gate: port ${p.port} is serving.\n`);
    }
    return true;
};

// Services that declare a healthcheck (and haven't disabled it) are the ones we gate on. A compose
// that declares none relies solely on the port probe above.
const healthcheckedServices = (composeYaml: string): string[] => {
    try {
        const parsed = YAML.parse(composeYaml) as { services?: Record<string, { healthcheck?: { disable?: boolean } }> };
        const services = parsed?.services || {};
        return Object.entries(services)
            .filter(([, svc]) => svc?.healthcheck && !svc.healthcheck.disable)
            .map(([name]) => name);
    } catch {
        return [];
    }
};

const waitForComposeHealthy = async (dep: DesiredDeployment, deadline: number): Promise<boolean> => {
    const services = healthcheckedServices(dep.compose);
    if (!services.length) return true; // nothing to gate on; the port probe is the readiness signal
    const project = composeProjectName(dep);
    while (Date.now() < deadline) {
        const ids = await composeContainerIds(project, dep);
        if (ids.length) {
            const statuses = await Promise.all(ids.map((id) => containerHealth(id)));
            // "none" = a container without a healthcheck (ignore); gate only on health-defined ones.
            const relevant = statuses.filter((s) => s !== 'none');
            if (relevant.length && relevant.every((s) => s === 'healthy')) return true;
            if (relevant.some((s) => s === 'unhealthy')) {
                // keep polling briefly - a container can flap to healthy - but let the deadline decide
            }
        }
        await new Promise((r) => setTimeout(r, config.readinessIntervalMs));
    }
    return false;
};

const composeContainerIds = async (project: string, dep: DesiredDeployment): Promise<string[]> => {
    const cmd = `(cd ${workdirFor(dep)} && docker compose -p ${project} ps -q)`;
    const { out, code } = await execSafe(cmd, 10000, composeChildEnv());
    if (code !== 0) return [];
    return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{12,}$/i.test(l));
};

const containerHealth = async (containerId: string): Promise<'healthy' | 'unhealthy' | 'starting' | 'none'> => {
    const cmd = `docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${containerId}`;
    const { out, code } = await execSafe(cmd, 10000);
    if (code !== 0) return 'none';
    const status = out.trim();
    if (status === 'healthy' || status === 'unhealthy' || status === 'starting') return status;
    return 'none';
};
