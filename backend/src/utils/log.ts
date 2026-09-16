import pino from 'pino';
import { config } from '@/config';

// Structured JSON logging. nsmd runs under systemd; journald captures stdout and the per-node
// Alloy agent ships it to Loki, so control-plane logs are filterable alongside app logs.
// redact censors sensitive values (auth tokens, cluster secret, private keys, dotenv, push keys)
// so the broad action logging below can never leak credentials into journald/Loki.
// Sensitive keys censored from every log line. Exported so tests can assert the policy directly.
export const REDACT_PATHS = [
    'req.headers.authorization',
    'token',
    '*.token',
    'secret',
    '*.secret',
    'clusterSecret',
    'privateKey',
    '*.privateKey',
    'password',
    '*.password',
    'keys.auth',
    'keys.p256dh',
    'dotenv',
];

// Emit every log line always (down to debug: reconcile/gossip ticks, deploy stream, probes). There
// is no level knob - the control plane logs everything it does so operators never miss an action.
export const log = pino({
    level: 'debug',
    base: { nodeId: config.nodeId, role: config.role },
    redact: {
        paths: REDACT_PATHS,
        censor: '[redacted]',
    },
});

// Subsystem child logger: adds an `area` field so logs are filterable in Loki via
// `source="nsmd" | json | area="reconcile"`. Use one per subsystem (e.g. areaLog('cluster')).
export const areaLog = (area: string) => log.child({ area });

// Child logger carrying deployment correlation fields so a deploy's control-plane logs are
// filterable by projectInstanceId in Loki (via `| json | projectInstanceId="..."`).
export const deployLogger = (projectId: string, projectInstanceId: string) => log.child({ area: 'deploy', projectId, projectInstanceId });
