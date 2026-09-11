import pino from 'pino';
import { config } from '@/config';

// Structured JSON logging. nsmd runs under systemd; journald captures stdout and the per-node
// Alloy agent ships it to Loki, so control-plane logs are filterable alongside app logs.
export const log = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { nodeId: config.nodeId, role: config.role },
});

// Child logger carrying deployment correlation fields so a deploy's control-plane logs are
// filterable by projectInstanceId in Loki (via `| json | projectInstanceId="..."`).
export const deployLogger = (projectId: string, projectInstanceId: string) => log.child({ projectId, projectInstanceId });
