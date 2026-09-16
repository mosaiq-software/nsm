import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Capture the child logger the middleware logs through by mocking areaLog. vi.hoisted lets the
// shared array exist before the hoisted vi.mock factory references it.
const { logCalls } = vi.hoisted(() => ({ logCalls: [] as { level: string; obj: any; msg: string }[] }));
vi.mock('@/utils/log', () => {
    const push = (level: string) => (obj: any, msg: string) => logCalls.push({ level, obj, msg });
    return { areaLog: () => ({ debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }) };
});

import { requestLogger } from '@/middleware/requestLog';

const run = (method: string, path: string, statusCode: number) => {
    const req: any = { method, path, headers: {} };
    const res: any = new EventEmitter();
    res.statusCode = statusCode;
    requestLogger(req, res, () => {});
    res.emit('finish');
    return logCalls[logCalls.length - 1];
};

describe('requestLogger', () => {
    beforeEach(() => {
        logCalls.length = 0;
    });

    it('logs a 2xx API request at info with method/path/status/duration', () => {
        const call = run('POST', '/project/create', 200);
        expect(call.level).toBe('info');
        expect(call.obj).toMatchObject({ action: 'http_request', method: 'POST', path: '/project/create', status: 200 });
        expect(typeof call.obj.durationMs).toBe('number');
        expect(typeof call.obj.reqId).toBe('string');
    });

    it('logs 4xx at warn and 5xx at error', () => {
        expect(run('GET', '/project/x', 404).level).toBe('warn');
        expect(run('POST', '/project/create', 500).level).toBe('error');
    });

    it('demotes health/metrics and static assets to debug', () => {
        expect(run('GET', '/healthz', 200).level).toBe('debug');
        expect(run('GET', '/metrics', 200).level).toBe('debug');
        expect(run('GET', '/assets/index-abc123.js', 200).level).toBe('debug');
    });
});
