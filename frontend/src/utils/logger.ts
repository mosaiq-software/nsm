import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import type { ClientLogEntry, ClientLogLevel } from '@mosaiq/nsm-common/types';

// Structured client-side logger. Every call (a) mirrors to the browser console and (b) batches a
// structured entry that is best-effort shipped to the leader (POST_CLIENT_LOGS), where it is written
// through pino tagged `service: 'client'` so it lands in Loki next to server logs. Shipping uses a
// dedicated fetch (not the api.ts helpers) so that logging an API failure can never recurse back
// through the logger. It never throws: logging must not be able to break the app.

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const CLIENT_LOGS_URL = `${API_BASE}${API_ROUTES.POST_CLIENT_LOGS}`;
const APP_VERSION: string | undefined = import.meta.env.VITE_APP_VERSION;

// Batch/flush tuning. The queue is capped so a backend outage can't grow memory unbounded; oldest
// entries are dropped first (a counter is logged so the loss is visible).
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE = 200;

let authToken: string | undefined;
let queue: ClientLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let shipping = false;
let droppedSinceLastFlush = 0;

// Set (or clear) the bearer token used to ship logs. Called by the user context on sign-in/out.
export const setLogAuthToken = (token: string | undefined): void => {
    authToken = token;
    if (token) scheduleFlush();
};

// Best-effort client-side error serialization mirroring the backend serializeError shape, so client
// and server error logs look the same in Loki. Accepts unknown so it is safe on any caught value.
const serializeClientError = (e: unknown): Record<string, unknown> => {
    if (e instanceof Error) {
        const anyErr = e as any;
        const out: Record<string, unknown> = { message: e.message, name: e.name, stack: e.stack };
        if (anyErr.code !== undefined) out.code = anyErr.code;
        const status = anyErr.statusCode ?? anyErr.status;
        if (status !== undefined) out.statusCode = status;
        if (anyErr.body !== undefined) out.body = anyErr.body;
        return out;
    }
    if (typeof e === 'object' && e !== null) return { ...(e as Record<string, unknown>) };
    return { message: String(e) };
};

const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flush();
    }, FLUSH_INTERVAL_MS);
};

// Ship queued entries. `keepalive` lets the final flush complete during page unload. Failures are
// swallowed (only echoed to console.debug) and the batch is re-queued so a transient outage doesn't
// lose logs - but never re-logged through this logger, which would recurse.
const flush = async (): Promise<void> => {
    if (shipping || !authToken || queue.length === 0) return;
    shipping = true;
    const batch = queue;
    queue = [];
    try {
        await fetch(CLIENT_LOGS_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
            keepalive: true,
        });
    } catch (e) {
        // Re-queue (respecting the cap) so a transient failure retries on the next flush.
        queue = [...batch, ...queue].slice(-MAX_QUEUE);
        scheduleFlush();
        // eslint-disable-next-line no-console
        console.debug('client log shipping failed', e);
    } finally {
        shipping = false;
        if (queue.length > 0) scheduleFlush();
    }
};

const enqueue = (entry: ClientLogEntry): void => {
    queue.push(entry);
    if (queue.length > MAX_QUEUE) {
        queue = queue.slice(-MAX_QUEUE);
        droppedSinceLastFlush++;
    }
    if (queue.length >= BATCH_SIZE) void flush();
    else scheduleFlush();
};

const consoleFor = (level: ClientLogLevel): ((...args: unknown[]) => void) => {
    // Mirror to console: everything in dev; only warn/error in prod to keep the console usable.
    if (import.meta.env.DEV) return (console[level] ?? console.log).bind(console);
    if (level === 'error') return console.error.bind(console);
    if (level === 'warn') return console.warn.bind(console);
    return () => {};
};

const emit = (level: ClientLogLevel, area: string, msg: string, fields?: Record<string, unknown>): void => {
    try {
        let err: unknown;
        let rest: Record<string, unknown> | undefined = fields;
        if (fields && 'err' in fields) {
            err = serializeClientError(fields.err);
            const { err: _omit, ...others } = fields;
            rest = Object.keys(others).length ? others : undefined;
        }
        const entry: ClientLogEntry = {
            ts: Date.now(),
            level,
            area,
            msg,
            ...(err !== undefined ? { err } : {}),
            url: typeof location !== 'undefined' ? location.href : undefined,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
            appVersion: APP_VERSION,
            ...(rest ? { fields: rest } : {}),
        };
        consoleFor(level)(`[${area}] ${msg}`, err ?? rest ?? '');
        enqueue(entry);
    } catch {
        // Logging must never throw.
    }
};

export const logger = {
    debug: (area: string, msg: string, fields?: Record<string, unknown>) => emit('debug', area, msg, fields),
    info: (area: string, msg: string, fields?: Record<string, unknown>) => emit('info', area, msg, fields),
    warn: (area: string, msg: string, fields?: Record<string, unknown>) => emit('warn', area, msg, fields),
    error: (area: string, msg: string, fields?: Record<string, unknown>) => emit('error', area, msg, fields),
    flush,
};

// Register global capture for uncaught errors and unhandled promise rejections, plus flush-on-hide
// so pending logs are shipped before the tab is backgrounded or closed. Call once at startup.
export const installGlobalErrorCapture = (): void => {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (event: ErrorEvent) => {
        logger.error('window', event.message || 'uncaught error', {
            err: event.error ?? { message: event.message },
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
        });
    });
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        logger.error('window', 'unhandled promise rejection', { err: event.reason });
    });
    // pagehide/visibilitychange are the reliable unload signals on mobile Safari; flush best-effort.
    const flushOnHide = () => {
        if (droppedSinceLastFlush > 0) {
            logger.warn('logger', `dropped ${droppedSinceLastFlush} client log(s) over queue cap`, { dropped: droppedSinceLastFlush });
            droppedSinceLastFlush = 0;
        }
        void flush();
    };
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide();
    });
};
