import * as fs from 'fs';
import * as path from 'path';
import { NodeConfigUpdate } from '@mosaiq/nsm-common/envSchema';

// The node's environment file in production. It is owned by the `nsm` user (chmod 640), so the
// daemon can read and rewrite it directly without sudo. systemd re-reads it via EnvironmentFile on
// the next restart, and config.ts loads it via dotenv at process start.
export const NODE_ENV_FILE = '/etc/nsm/nsm.env';

const ASSIGNMENT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

// Strip a single layer of matching surrounding quotes and unescape the minimal set we emit.
const unquote = (raw: string): string => {
    const v = raw.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        const inner = v.slice(1, -1);
        return v[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
    }
    return v;
};

// Quote a value only when needed so plain values stay readable (matching .env.sample style). Values
// with surrounding/inner whitespace, a comment marker, or quote characters are double-quoted; both
// dotenv and systemd's EnvironmentFile parser understand this quoting.
const formatValue = (value: string): string => {
    if (value === '') return '';
    const needsQuote = /[\s#"'`$]/.test(value) || value !== value.trim();
    if (!needsQuote) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

// Parse KEY=VALUE lines from an env file's text into a map. Comments and blank lines are ignored.
export const parseEnvText = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = line.match(ASSIGNMENT_RE);
        if (m) out[m[1]] = unquote(m[2]);
    }
    return out;
};

// Read and parse an env file. Returns an empty map if the file does not exist.
export const readEnvFile = (filePath: string = NODE_ENV_FILE): Record<string, string> => {
    try {
        return parseEnvText(fs.readFileSync(filePath, 'utf-8'));
    } catch (e: any) {
        if (e?.code === 'ENOENT') return {};
        throw e;
    }
};

// Apply a set/unset update to an env file, preserving existing comments and key order. Keys in
// `set` that already exist are replaced in place; new keys are appended. Keys in `unset` are
// removed. The prior file is copied to `<file>.bak` first, and the new content is written to a temp
// file in the same directory then atomically renamed into place with mode 640.
export const writeEnvFile = (update: NodeConfigUpdate, filePath: string = NODE_ENV_FILE): void => {
    const setKeys = new Set(Object.keys(update.set));
    const unsetKeys = new Set(update.unset);

    let existing = '';
    try {
        existing = fs.readFileSync(filePath, 'utf-8');
    } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
    }

    if (existing) {
        try {
            fs.copyFileSync(filePath, `${filePath}.bak`);
        } catch {
            /* best-effort backup */
        }
    }

    const applied = new Set<string>();
    const lines = existing.length ? existing.split('\n') : [];
    const outLines: string[] = [];
    for (const line of lines) {
        const m = line.match(ASSIGNMENT_RE);
        const key = m?.[1];
        if (key && unsetKeys.has(key)) continue; // drop
        if (key && setKeys.has(key)) {
            outLines.push(`${key}=${formatValue(update.set[key])}`);
            applied.add(key);
            continue;
        }
        outLines.push(line);
    }

    // Append any set keys that weren't already present in the file.
    const appended: string[] = [];
    for (const key of setKeys) {
        if (!applied.has(key)) appended.push(`${key}=${formatValue(update.set[key])}`);
    }
    if (appended.length) {
        if (outLines.length && outLines[outLines.length - 1].trim() !== '') outLines.push('');
        outLines.push(...appended);
    }

    let content = outLines.join('\n');
    if (!content.endsWith('\n')) content += '\n';

    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.nsm.env.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, content, { mode: 0o640 });
    fs.renameSync(tmp, filePath);
};
