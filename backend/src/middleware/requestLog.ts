import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';
import { areaLog, runWithRequestContext } from '@/utils/log';

const httpLog = areaLog('http');

// Health/metrics are polled constantly and static assets are served on every page load; logging
// them at info would drown the meaningful API actions, so they are demoted to debug.
const isNoisyPath = (method: string, path: string): boolean => {
    if (path === '/healthz' || path === '/metrics') return true;
    // Static asset GETs (anything with a file extension, e.g. /assets/index-abc.js, /favicon.ico).
    if (method === 'GET' && /\.[a-z0-9]+$/i.test(path)) return true;
    return false;
};

// Access log for every request. Emitted on response finish with method, path, status, duration and
// a per-request id, so the control-plane log shows every API action as it happens.
export const requestLogger: RequestHandler = (req, res, next) => {
    const start = process.hrtime.bigint();
    const reqId = randomUUID();
    (req as unknown as { reqId?: string }).reqId = reqId;
    res.on('finish', () => {
        const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : isNoisyPath(req.method, req.path) ? 'debug' : 'info';
        httpLog[level](
            { action: 'http_request', reqId, method: req.method, path: req.path, status: res.statusCode, durationMs },
            `${req.method} ${req.path} ${res.statusCode}`
        );
    });
    // Run the rest of the request inside the reqId context so every log line emitted while handling
    // this request (including in awaited async work) is correlated via the pino mixin.
    runWithRequestContext({ reqId }, () => next());
};
