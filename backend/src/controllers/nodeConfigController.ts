import { config } from '@/config';
import { execSafe } from '@/host/exec';
import { sudo } from '@/host/privilege';
import { readEnvFile, writeEnvFile } from '@/host/envFile';
import { cluster } from '@/cluster/node';
import { postToNode } from '@/cluster/leaderClient';
import { getNodeByIdModel } from '@/persistence/nodePersistence';
import { sendPushToAdmins } from '@/controllers/pushController';
import { EDITABLE_ENV_KEYS, getEnvSpec, NodeConfigUpdate, NodeConfigValues } from '@mosaiq/nsm-common/envSchema';
import { areaLog, serializeError } from '@/utils/log';

const cfgLog = areaLog('nodeConfig');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Build the editor's view of a parsed env file: real values for plain vars, length-only for secrets
// so secret values never leave this process.
const buildMaskedValues = (fileMap: Record<string, string>): NodeConfigValues => {
    const out: NodeConfigValues = {};
    for (const spec of EDITABLE_ENV_KEYS) {
        const def = getEnvSpec(spec)!;
        const raw = fileMap[def.key];
        if (def.secret) out[def.key] = { isSecret: true, length: (raw ?? '').length };
        else out[def.key] = { value: raw ?? null };
    }
    return out;
};

// Validate a change set against the shared schema so only well-typed values for editable keys are
// ever written. Throws on the first problem with a human-readable message.
const validateUpdate = (update: NodeConfigUpdate): void => {
    if (!update || typeof update !== 'object') throw new Error('Invalid config update');
    const set = update.set ?? {};
    const unset = update.unset ?? [];

    for (const key of unset) {
        const spec = getEnvSpec(key);
        if (!spec) throw new Error(`Unknown or non-editable variable: ${key}`);
        if (spec.required) throw new Error(`${key} is required and cannot be cleared`);
        if (key in set) throw new Error(`${key} cannot be both set and unset`);
    }

    for (const [key, rawValue] of Object.entries(set)) {
        const spec = getEnvSpec(key);
        if (!spec) throw new Error(`Unknown or non-editable variable: ${key}`);
        if (typeof rawValue !== 'string') throw new Error(`${key} must be a string`);
        const value = rawValue;
        if (value.trim() === '') {
            if (spec.required) throw new Error(`${key} is required`);
            continue; // empty optional value is allowed (equivalent to clearing)
        }
        switch (spec.type) {
            case 'number':
                if (isNaN(Number(value))) throw new Error(`${key} must be a number`);
                break;
            case 'boolean':
                if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
                break;
            case 'enum':
                if (!spec.options?.includes(value)) throw new Error(`${key} must be one of: ${spec.options?.join(', ')}`);
                break;
            case 'url':
                try {
                    new URL(value);
                } catch {
                    throw new Error(`${key} must be a valid URL`);
                }
                break;
            case 'string':
            default:
                break;
        }
    }
};

// Read THIS host's editable config (secrets masked). Used by the internal /node/config-values RPC.
export const readLocalConfig = (): NodeConfigValues => buildMaskedValues(readEnvFile());

// Read a node's editable config (secrets masked). Reads locally when this is the target node,
// otherwise fetches from the target node over the cluster RPC.
export const readNodeConfig = async (nodeId: string): Promise<NodeConfigValues> => {
    if (nodeId === config.nodeId) return buildMaskedValues(readEnvFile());
    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found in cluster`);
    const res = await postToNode<NodeConfigValues>(node.address, node.apiPort, '/node/config-values', {}, 10000);
    if (!res) throw new Error(`Could not reach node ${nodeId}`);
    return res;
};

// Write the update to this host's env file and restart nsmd so it is picked up. The restart is
// delayed slightly and detached so the HTTP response can flush and (on the leader) the "restarting"
// notification can be sent before the process is replaced.
export const applyLocalConfig = (update: NodeConfigUpdate): void => {
    validateUpdate(update);
    if (!config.production) {
        cfgLog.info({ action: 'apply_config_skipped_dev', setKeys: Object.keys(update.set ?? {}), unset: update.unset ?? [] }, '(dev) would write env file and restart nsmd');
        return;
    }
    writeEnvFile(update);
    cfgLog.info({ action: 'config_written', setKeys: Object.keys(update.set ?? {}), unset: update.unset ?? [] }, 'wrote node env file; scheduling restart');
    setTimeout(() => {
        cfgLog.info({ action: 'systemd_restart' }, 'restarting nsmd via systemd after config change');
        void execSafe(sudo('systemctl restart nsmd'), 5000);
    }, 1000).unref();
};

// A follower's uptime as reported by GET /node/ping, or null if unreachable.
const pingUptimeMs = async (address: string, apiPort: number): Promise<number | null> => {
    const res = await postToNode<{ ok: boolean; uptimeMs: number }>(address, apiPort, '/node/ping', {}, 3000);
    return res?.ok ? res.uptimeMs : null;
};

// After instructing a follower to restart, watch it via /node/ping. A restart is confirmed when the
// reported uptime resets (goes backwards) or the node drops and returns healthy. Notifies admins of
// the outcome. Best-effort and self-contained: never throws.
const watchFollowerRestart = async (nodeId: string, address: string, apiPort: number): Promise<void> => {
    try {
        const baseline = (await pingUptimeMs(address, apiPort)) ?? Number.POSITIVE_INFINITY;
        const deadline = Date.now() + 90_000;
        let sawDown = false;
        while (Date.now() < deadline) {
            await sleep(2000);
            const uptime = await pingUptimeMs(address, apiPort);
            if (uptime === null) {
                sawDown = true;
                continue;
            }
            // A fresh process reports a smaller uptime than before the restart (or than the baseline).
            if (sawDown || uptime + 3000 < baseline) {
                cfgLog.info({ action: 'follower_restart_confirmed', nodeId }, `${nodeId} came back healthy after config change`);
                await sendPushToAdmins('Node restarted', `${nodeId} restarted successfully after a configuration change.`, `/nodes/${nodeId}`);
                return;
            }
        }
        cfgLog.warn({ action: 'follower_restart_unconfirmed', nodeId, sawDown }, `could not confirm ${nodeId} restart within timeout`);
        await sendPushToAdmins('Node restart may have failed', sawDown ? `${nodeId} went down after a configuration change but did not report healthy within 90s. Check the node.` : `Could not confirm ${nodeId} restarted after a configuration change. Check the node.`, `/nodes/${nodeId}`);
    } catch (e: any) {
        cfgLog.error({ action: 'follower_watch_failed', nodeId, err: serializeError(e) }, 'follower restart watch failed');
    }
};

// Leader entry point: validate, then apply on the target node (self or follower) and restart it,
// notifying admins. For the leader itself the restart cannot be verified, so only the "restarting"
// notification is sent.
export const applyNodeConfig = async (nodeId: string, update: NodeConfigUpdate, actingLogin: string): Promise<{ ok: boolean }> => {
    validateUpdate(update);

    if (nodeId === config.nodeId) {
        await sendPushToAdmins('Node restarting', `${actingLogin} updated configuration on ${nodeId} (this leader); restarting now. Leader restart status cannot be verified automatically.`, `/nodes/${nodeId}`);
        applyLocalConfig(update);
        return { ok: true };
    }

    const node = await getNodeByIdModel(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found in cluster`);
    const res = await postToNode<{ ok: boolean }>(node.address, node.apiPort, '/node/config-apply', update, 15000);
    if (!res?.ok) throw new Error(`Could not apply configuration on node ${nodeId} (node unreachable or rejected the change)`);

    await sendPushToAdmins('Node restarting', `${actingLogin} updated configuration on ${nodeId}; restarting now.`, `/nodes/${nodeId}`);
    void watchFollowerRestart(nodeId, node.address, node.apiPort);
    return { ok: true };
};
