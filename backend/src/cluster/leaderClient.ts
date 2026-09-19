import type { Request, Response } from 'express';
import { config } from '@/config';
import { cluster } from './node';
import { areaLog, serializeError } from '@/utils/log';

const clientLog = areaLog('leaderClient');

export const CLUSTER_SECRET_HEADER = 'x-nsm-cluster-secret';

// POST a JSON body to an endpoint on the current leader, authenticated with the cluster secret.
export const postToLeader = async <T = any>(path: string, body: any): Promise<T | null> => {
    const base = cluster.leaderAddress();
    if (!base) {
        clientLog.warn({ action: 'post_to_leader_no_leader', path }, 'no leader address configured');
        return null;
    }
    try {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CLUSTER_SECRET_HEADER]: config.clusterSecret },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            clientLog.warn({ action: 'post_to_leader_failed', path, status: res.status, leaderAddress: base }, `POST ${path} to leader returned ${res.status}`);
            return null;
        }
        const text = await res.text();
        clientLog.debug({ action: 'post_to_leader_ok', path, status: res.status }, `POST ${path} to leader ok`);
        return text ? (JSON.parse(text) as T) : null;
    } catch (e: any) {
        clientLog.warn({ action: 'post_to_leader_error', path, leaderAddress: base, err: serializeError(e) }, `POST ${path} to leader failed`);
        return null;
    }
};

// POST to a specific node's API (used for leader -> node operational RPCs like port planning).
export const postToNode = async <T = any>(address: string, apiPort: number, path: string, body: any, timeoutMs = 30000): Promise<T | null> => {
    try {
        const res = await fetch(`http://${address}:${apiPort}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CLUSTER_SECRET_HEADER]: config.clusterSecret },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            clientLog.warn({ action: 'post_to_node_failed', address, apiPort, path, status: res.status }, `POST ${path} to ${address} returned ${res.status}`);
            return null;
        }
        const text = await res.text();
        clientLog.debug({ action: 'post_to_node_ok', address, apiPort, path }, `POST ${path} to ${address} ok`);
        return text ? (JSON.parse(text) as T) : null;
    } catch (e: any) {
        clientLog.warn({ action: 'post_to_node_error', address, apiPort, path, err: serializeError(e) }, `POST ${path} to ${address} failed`);
        return null;
    }
};

// Transparently proxy a write request to the leader and pipe back the response.
export const forwardToLeader = async (req: Request, res: Response): Promise<void> => {
    const base = cluster.leaderAddress();
    if (!base) {
        clientLog.warn({ action: 'forward_no_leader', method: req.method, originalUrl: req.originalUrl }, 'cannot forward: no leader');
        res.status(503).send('No leader elected yet');
        return;
    }
    try {
        const url = `${base}${req.originalUrl}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (req.headers['authorization']) headers['Authorization'] = String(req.headers['authorization']);
        headers[CLUSTER_SECRET_HEADER] = config.clusterSecret;
        const method = req.method.toUpperCase();
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const upstream = await fetch(url, {
            method,
            headers,
            body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
            signal: AbortSignal.timeout(10 * 60 * 1000),
        });
        const text = await upstream.text();
        res.status(upstream.status);
        const ct = upstream.headers.get('content-type');
        if (ct) res.setHeader('content-type', ct);
        res.send(text);
        clientLog.debug({ action: 'forward_completed', method, originalUrl: req.originalUrl, upstreamStatus: upstream.status }, `forwarded ${method} ${req.originalUrl} -> ${upstream.status}`);
    } catch (e: any) {
        clientLog.warn({ action: 'forward_failed', method: req.method, originalUrl: req.originalUrl, err: serializeError(e) }, `failed to forward ${req.method} ${req.originalUrl}`);
        res.status(502).send(`Failed to reach leader: ${e.message}`);
    }
};
