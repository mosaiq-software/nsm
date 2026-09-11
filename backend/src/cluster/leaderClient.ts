import type { Request, Response } from 'express';
import { config } from '@/config';
import { cluster } from './node';

export const CLUSTER_SECRET_HEADER = 'x-nsm-cluster-secret';

// POST a JSON body to an endpoint on the current leader, authenticated with the cluster secret.
export const postToLeader = async <T = any>(path: string, body: any): Promise<T | null> => {
    const base = cluster.leaderAddress();
    if (!base) return null;
    try {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CLUSTER_SECRET_HEADER]: config.clusterSecret },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
    } catch (e) {
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
        if (!res.ok) return null;
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
    } catch {
        return null;
    }
};

// Transparently proxy a write request to the leader and pipe back the response.
export const forwardToLeader = async (req: Request, res: Response): Promise<void> => {
    const base = cluster.leaderAddress();
    if (!base) {
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
    } catch (e: any) {
        res.status(502).send(`Failed to reach leader: ${e.message}`);
    }
};
