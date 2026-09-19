import { ClientLogEntry, ClientLogLevel } from '@mosaiq/nsm-common/types';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { log } from '@/utils/log';

// Ships frontend logs into the same pino stream as server logs, tagged `service: 'client'` so the
// NSM Logs UI can tell them apart. Writes go through a child logger so REDACT_PATHS and the reqId
// mixin still apply. Caps guard against a malicious or buggy client flooding journald/Loki.
const clientLog = log.child({ service: 'client' });

const MAX_ENTRIES_PER_REQUEST = 100;
const MAX_MSG_LEN = 2000;
// Sliding per-user rate cap: at most this many client log lines accepted per window.
const RATE_WINDOW_MS = 60_000;
const MAX_ENTRIES_PER_WINDOW = 600;

const VALID_LEVELS: ReadonlySet<ClientLogLevel> = new Set(['debug', 'info', 'warn', 'error']);

// Per-user token bucket keyed by githubId. In-memory and leader-local, which is sufficient: this is
// abuse mitigation, not exact accounting.
const rateState = new Map<string, { windowStart: number; count: number }>();

const takeRateBudget = (githubId: string, want: number): number => {
    const now = Date.now();
    const state = rateState.get(githubId);
    if (!state || now - state.windowStart >= RATE_WINDOW_MS) {
        const grant = Math.min(want, MAX_ENTRIES_PER_WINDOW);
        rateState.set(githubId, { windowStart: now, count: grant });
        return grant;
    }
    const remaining = Math.max(0, MAX_ENTRIES_PER_WINDOW - state.count);
    const grant = Math.min(want, remaining);
    state.count += grant;
    return grant;
};

const clampMsg = (msg: unknown): string => {
    const s = typeof msg === 'string' ? msg : String(msg ?? '');
    return s.length > MAX_MSG_LEN ? `${s.slice(0, MAX_MSG_LEN)}…[truncated]` : s;
};

// Ingest a batch of client log entries from the signed-in user. Returns how many were accepted (some
// may be dropped by the per-request cap or the per-user rate window). Never throws for bad input:
// invalid entries are skipped and counted rather than failing the whole request.
export const ingestClientLogs = async (authToken: string, entries: ClientLogEntry[]): Promise<{ ok: boolean; accepted: number }> => {
    const user = await getUserByAuthTokenModel(authToken);
    if (!user) return { ok: false, accepted: 0 };

    const list = Array.isArray(entries) ? entries.slice(0, MAX_ENTRIES_PER_REQUEST) : [];
    const budget = takeRateBudget(user.githubId, list.length);
    if (budget < list.length) {
        clientLog.warn(
            { area: 'client-log', action: 'client_log_rate_limited', name: user.name, githubId: user.githubId, dropped: list.length - budget },
            `dropped ${list.length - budget} client log(s) over rate cap for ${user.name}`
        );
    }

    let accepted = 0;
    for (const entry of list.slice(0, budget)) {
        if (!entry || typeof entry !== 'object') continue;
        const level: ClientLogLevel = VALID_LEVELS.has(entry.level) ? entry.level : 'info';
        const bindings = {
            area: typeof entry.area === 'string' && entry.area ? entry.area : 'client',
            action: 'client_log',
            name: user.name,
            githubId: user.githubId,
            clientTs: typeof entry.ts === 'number' ? entry.ts : undefined,
            url: entry.url,
            userAgent: entry.userAgent,
            appVersion: entry.appVersion,
            err: entry.err,
            fields: entry.fields,
        };
        clientLog[level](bindings, clampMsg(entry.msg));
        accepted++;
    }
    return { ok: true, accepted };
};
