import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS, serializeError } from '@/utils/log';

// Build a logger with the real redaction policy but a captured destination, so we can assert that
// sensitive fields never reach the log stream.
const capture = (): { logger: pino.Logger; lines: string[] } => {
    const lines: string[] = [];
    const dest = { write: (s: string) => void lines.push(s) };
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, dest as any);
    return { logger, lines };
};

describe('log redaction', () => {
    it('censors tokens, secrets, cluster secret, private keys, dotenv, and push keys', () => {
        const { logger, lines } = capture();
        logger.info(
            {
                token: 'super-secret-token',
                clusterSecret: 'cluster-secret',
                secret: { secretValue: 'v' },
                privateKey: 'pk',
                dotenv: 'A=1\nB=2',
                user: { token: 'nested-token' },
                keys: { auth: 'a', p256dh: 'p' },
                projectId: 'visible-project',
            },
            'test'
        );
        const out = lines.join('');
        expect(out).not.toContain('super-secret-token');
        expect(out).not.toContain('cluster-secret');
        expect(out).not.toContain('nested-token');
        expect(out).toContain('[redacted]');
        // Non-sensitive fields remain visible for debugging.
        expect(out).toContain('visible-project');
    });

    it('censors an Authorization header nested under req.headers', () => {
        const { logger, lines } = capture();
        logger.info({ req: { headers: { authorization: 'Bearer abc123' } } }, 'req');
        expect(lines.join('')).not.toContain('abc123');
    });
});

describe('serializeError', () => {
    it('captures message, name, and stack from an Error', () => {
        const out = serializeError(new Error('boom'));
        expect(out.message).toBe('boom');
        expect(out.name).toBe('Error');
        expect(typeof out.stack).toBe('string');
    });

    it('extracts statusCode, endpoint, and response body (e.g. web-push WebPushError)', () => {
        const err = Object.assign(new Error('Received unexpected response code'), {
            statusCode: 403,
            endpoint: 'https://web.push.apple.com/abc',
            body: 'BadJwtToken',
        });
        const out = serializeError(err);
        expect(out.statusCode).toBe(403);
        expect(out.endpoint).toBe('https://web.push.apple.com/abc');
        expect(out.body).toBe('BadJwtToken');
    });

    it('serializes a nested cause and handles non-Error throwables', () => {
        const out = serializeError(new Error('outer', { cause: new Error('inner') }));
        expect((out.cause as any)?.message).toBe('inner');
        expect(serializeError('plain string').message).toBe('plain string');
        expect(serializeError({ message: 'objish', statusCode: 500 })).toMatchObject({ message: 'objish', statusCode: 500 });
    });
});
