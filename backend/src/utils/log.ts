import { AsyncLocalStorage } from 'async_hooks';
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

// Per-request context carried implicitly through async calls so every log line emitted while
// handling a request is tagged with its reqId, without threading a logger through every function.
interface RequestContext {
    reqId: string;
}
const requestContextStore = new AsyncLocalStorage<RequestContext>();

// Run fn with the given request context active; all logs emitted within (including in awaited async
// work) pick up its reqId via the pino mixin below.
export const runWithRequestContext = <T>(ctx: RequestContext, fn: () => T): T => requestContextStore.run(ctx, fn);

// The reqId of the in-flight request, if any (used by the pino mixin and by callers that want to
// correlate out-of-band work).
export const currentReqId = (): string | undefined => requestContextStore.getStore()?.reqId;

// A canonical, log-friendly shape for anything thrown. Plain `err: e.message` discards the stack,
// the cause chain, and - crucially for HTTP clients - the response body (e.g. web-push's WebPushError
// carries the push service's reason in `.body`, and axios/fetch wrappers carry it in `.response`).
// Accepts unknown so it is safe to call on any caught value.
export interface SerializedError {
    message: string;
    name?: string;
    stack?: string;
    code?: string | number;
    statusCode?: number;
    endpoint?: string;
    body?: unknown;
    cause?: unknown;
}

export const serializeError = (e: unknown): SerializedError => {
    if (e instanceof Error) {
        const anyErr = e as any;
        const out: SerializedError = {
            message: e.message,
            name: e.name,
            stack: e.stack,
        };
        if (anyErr.code !== undefined) out.code = anyErr.code;
        // web-push WebPushError uses statusCode; http libs often use status/statusCode.
        const status = anyErr.statusCode ?? anyErr.status ?? anyErr.response?.status;
        if (status !== undefined) out.statusCode = status;
        if (anyErr.endpoint !== undefined) out.endpoint = anyErr.endpoint;
        // Response body carrying the server's reason string: web-push `.body`, axios `.response.data`.
        const body = anyErr.body ?? anyErr.response?.data;
        if (body !== undefined) out.body = body;
        if (anyErr.cause !== undefined) out.cause = anyErr.cause instanceof Error ? serializeError(anyErr.cause) : anyErr.cause;
        return out;
    }
    if (typeof e === 'object' && e !== null) {
        const anyErr = e as any;
        return {
            message: String(anyErr.message ?? anyErr),
            code: anyErr.code,
            statusCode: anyErr.statusCode ?? anyErr.status,
            body: anyErr.body ?? anyErr.response?.data,
        };
    }
    return { message: String(e) };
};

// Emit every log line always (down to debug: reconcile/gossip ticks, deploy stream, probes). There
// is no level knob - the control plane logs everything it does so operators never miss an action.
// `service: 'server'` tags control-plane logs so the NSM Logs UI can separate them from shipped
// client-side logs (service: 'client'). The mixin stamps the active request's reqId onto every line.
export const log = pino({
    level: 'debug',
    base: { nodeId: config.nodeId, role: config.role, service: 'server' },
    mixin: () => {
        const reqId = currentReqId();
        return reqId ? { reqId } : {};
    },
    serializers: {
        // Safety net for any `err:` passed a raw Error (instead of serializeError(e)): serialize it
        // to the same canonical shape so stack/body/cause are never lost. Values that are already
        // serialized (plain objects, e.g. from serializeError or shipped client logs) pass through
        // unchanged rather than being re-wrapped.
        err: (e: unknown) => (e instanceof Error ? serializeError(e) : e),
    },
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
