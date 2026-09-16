import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from '@/utils/log';

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
