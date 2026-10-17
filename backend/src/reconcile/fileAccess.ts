import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import type { Readable } from 'stream';
import * as path from 'path';
import { DirectoryListing, FileClass, FileContent, FileEntry } from '@mosaiq/nsm-common/types';
import { ParsedRoot, serializeRootId } from '@mosaiq/nsm-common/fileExplorer';
import { config } from '@/config';
import { areaLog, serializeError } from '@/utils/log';

const fileLog = areaLog('fileExplorer');

// Caps that keep listings/reads bounded so a hostile or accidental giant file/dir can't exhaust
// memory or the event loop.
const MAX_DIR_ENTRIES = 2000;
const TEXT_PREVIEW_MAX = 1024 * 1024; // 1 MiB inline text cap
const RAW_STREAM_MAX = 1024 * 1024 * 1024; // 1 GiB hard ceiling for raw stream/download
const SNIFF_BYTES = 8192; // bytes inspected to decide text vs binary

export type FileErrorCode = 'forbidden' | 'not_found' | 'not_a_file' | 'too_large';

// A typed error the route layer maps to an HTTP status. Thrown for every expected failure so a
// handler never has to guess a status from a raw fs error.
export class FileAccessError extends Error {
    constructor(
        public readonly code: FileErrorCode,
        message?: string
    ) {
        super(message ?? code);
        this.name = 'FileAccessError';
    }
}

const isErrno = (e: unknown, code: string): boolean => typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;
const isMissing = (e: unknown): boolean => isErrno(e, 'ENOENT') || isErrno(e, 'ENOTDIR');

// Guard against a projectId or root segment that could itself contain path separators. project.id
// and the nginx server/location ids are controlled server-side, but this is cheap defense in depth.
const assertSafeSegment = (seg: string): void => {
    if (!seg || seg.includes('/') || seg.includes('\\') || seg === '.' || seg === '..' || seg.includes('\0')) {
        throw new FileAccessError('forbidden', 'invalid path segment');
    }
};

// Absolute base dir on THIS node for a validated root. Never derived from client-supplied paths.
export const baseDirFor = (projectId: string, root: ParsedRoot): string => {
    assertSafeSegment(projectId);
    if (root.kind === 'volume') return path.join(config.persistentPath, projectId, 'volume');
    assertSafeSegment(root.serverId);
    assertSafeSegment(root.locationId);
    return path.join(config.deploymentPath, projectId, 'www', root.serverId, root.locationId);
};

// THE security primitive. Returns the canonical target path or throws FileAccessError('forbidden').
// Guarantees the result is inside the project base AND that NO symlink was traversed to get there,
// so a symlink can never redirect into another project's dir or anywhere else on the host. A missing
// path surfaces as a native ENOENT/ENOTDIR for callers to translate (empty listing / not_found).
const resolveWithin = async (base: string, relPath: string): Promise<string> => {
    const rel = path
        .normalize(relPath || '')
        .replace(/^([/\\]|\.\.([/\\]|$))+/, '') // strip leading absolute markers and `..`
        .replace(/[/\\]+$/, ''); // drop trailing separators for a stable comparison
    const baseAbs = path.resolve(base);
    const target = path.resolve(baseAbs, rel);

    // 1) Lexical containment (cheap first cut against `..` / absolute paths).
    if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) throw new FileAccessError('forbidden', 'path escapes root');

    // 2) Canonicalize the base (its ancestors like /var may legitimately be symlinks) and the target.
    //    realpath throws ENOENT for a missing target, which callers map to empty/not_found.
    const realBase = await fs.realpath(baseAbs);
    const realTarget = await fs.realpath(target);

    // 3) Canonical containment under the canonical base.
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) throw new FileAccessError('forbidden', 'path escapes root');

    // 4) NO-SYMLINK rule: the canonical target must equal the lexical join of realBase + rel. Any
    //    difference means a symlink was followed somewhere below the base -> reject outright, even if
    //    it would have resolved back inside the project. Keeps every traversal provably symlink-free.
    if (realTarget !== path.resolve(realBase, rel)) throw new FileAccessError('forbidden', 'symlink traversal is not allowed');

    return realTarget;
};

// Directories first, then case-insensitive name order.
const dirsFirstThenName = (a: FileEntry, b: FileEntry): number => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};

export const listDirectoryLocal = async (projectId: string, root: ParsedRoot, relPath: string): Promise<DirectoryListing> => {
    const rootId = serializeRootId(root);
    const base = baseDirFor(projectId, root);
    let real: string;
    try {
        real = await resolveWithin(base, relPath);
    } catch (e) {
        // A not-yet-created base dir (pre-first-deploy) or missing sub-path lists as empty.
        if (isMissing(e)) return { rootId, path: relPath, entries: [], truncated: false };
        throw e;
    }

    let dirents;
    try {
        dirents = await fs.readdir(real, { withFileTypes: true });
    } catch (e) {
        if (isErrno(e, 'ENOTDIR')) throw new FileAccessError('not_a_file', 'path is not a directory');
        if (isMissing(e)) return { rootId, path: relPath, entries: [], truncated: false };
        throw e;
    }

    const truncated = dirents.length > MAX_DIR_ENTRIES;
    const entries: FileEntry[] = [];
    for (const d of dirents.slice(0, MAX_DIR_ENTRIES)) {
        const full = path.join(real, d.name);
        let lst;
        try {
            lst = await fs.lstat(full); // lstat: do NOT auto-follow symlinks
        } catch (e) {
            fileLog.debug({ action: 'lstat_failed', projectId, rootId, name: d.name, err: serializeError(e) }, 'skipping entry that failed to stat');
            continue;
        }
        if (lst.isSymbolicLink()) {
            // Symlinks are disallowed: list for visibility but never navigable/readable. Never stat
            // the target or expose where it points.
            entries.push({ name: d.name, type: 'symlink', size: 0, mtimeMs: lst.mtimeMs });
        } else {
            entries.push({
                name: d.name,
                type: lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : 'other',
                size: lst.isFile() ? lst.size : 0,
                mtimeMs: lst.mtimeMs,
            });
        }
    }
    entries.sort(dirsFirstThenName);
    return { rootId, path: relPath, entries, truncated };
};

const IMAGE_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
};
const VIDEO_EXT: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
};
const AUDIO_EXT: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
};

// Extension -> highlight.js language id for the text viewer. Missing extensions fall back to
// undefined (plain text), which @mantine/code-highlight renders without highlighting.
const LANGUAGE_BY_EXT: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.html': 'xml',
    '.htm': 'xml',
    '.xml': 'xml',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'ini',
    '.ini': 'ini',
    '.env': 'bash',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.sql': 'sql',
    '.dockerfile': 'dockerfile',
    '.conf': 'nginx',
};
const TEXT_EXT = new Set(['.txt', '.log', '.text', '.csv', '.tsv', '.gitignore', '.dockerignore', '.editorconfig', '.lock', ...Object.keys(LANGUAGE_BY_EXT)]);

// Heuristic text/binary sniff: a NUL byte or a high ratio of non-printable control bytes marks the
// file binary. High bytes (>= 128) are allowed since they may be valid UTF-8 multibyte sequences.
const sniffIsText = (buf: Buffer): boolean => {
    if (buf.includes(0)) return false;
    let suspicious = 0;
    for (const b of buf) {
        if (b === 9 || b === 10 || b === 13) continue; // tab / LF / CR
        if (b < 32) suspicious++;
    }
    return suspicious / Math.max(1, buf.length) < 0.1;
};

const classify = async (real: string, size: number): Promise<{ fileClass: FileClass; mimeType: string; language?: string }> => {
    const ext = path.extname(real).toLowerCase();
    if (IMAGE_EXT[ext]) return { fileClass: 'image', mimeType: IMAGE_EXT[ext] };
    if (VIDEO_EXT[ext]) return { fileClass: 'video', mimeType: VIDEO_EXT[ext] };
    if (AUDIO_EXT[ext]) return { fileClass: 'audio', mimeType: AUDIO_EXT[ext] };
    if (ext === '.pdf') return { fileClass: 'pdf', mimeType: 'application/pdf' };

    // Text decision: trust a known text extension, otherwise sniff the leading bytes.
    let isText = TEXT_EXT.has(ext);
    if (!isText && size > 0) {
        const fd = await fs.open(real, 'r');
        try {
            const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            isText = sniffIsText(buf.subarray(0, bytesRead));
        } finally {
            await fd.close();
        }
    } else if (!isText && size === 0) {
        isText = true; // empty files render fine as empty text
    }
    if (isText) return { fileClass: 'text', mimeType: 'text/plain; charset=utf-8', language: LANGUAGE_BY_EXT[ext] };
    return { fileClass: 'binary', mimeType: 'application/octet-stream' };
};

export const readFileLocal = async (projectId: string, root: ParsedRoot, relPath: string): Promise<FileContent> => {
    const rootId = serializeRootId(root);
    let real: string;
    try {
        real = await resolveWithin(baseDirFor(projectId, root), relPath);
    } catch (e) {
        if (isMissing(e)) throw new FileAccessError('not_found', 'file not found');
        throw e;
    }
    const st = await fs.stat(real).catch((e) => {
        if (isMissing(e)) throw new FileAccessError('not_found', 'file not found');
        throw e;
    });
    if (!st.isFile()) throw new FileAccessError('not_a_file', 'not a regular file');

    const name = path.basename(real);
    const base = { rootId, path: relPath, name, size: st.size, mtimeMs: st.mtimeMs };
    const cls = await classify(real, st.size);

    if (cls.fileClass === 'text') {
        const readLen = Math.min(st.size, TEXT_PREVIEW_MAX);
        const fd = await fs.open(real, 'r');
        try {
            const buf = Buffer.alloc(readLen);
            const { bytesRead } = await fd.read(buf, 0, readLen, 0);
            return {
                ...base,
                fileClass: 'text',
                mimeType: cls.mimeType,
                text: buf.subarray(0, bytesRead).toString('utf8'),
                truncated: st.size > TEXT_PREVIEW_MAX,
                language: cls.language,
                previewAvailable: true,
            };
        } finally {
            await fd.close();
        }
    }

    // Media is previewable via the raw endpoint; pdf/binary are download-only.
    const previewAvailable = cls.fileClass === 'image' || cls.fileClass === 'video' || cls.fileClass === 'audio';
    return { ...base, fileClass: cls.fileClass, mimeType: cls.mimeType, previewAvailable };
};

export interface RawFileStream {
    stream: Readable;
    name: string;
    mimeType: string;
    size: number; // full file size
    start: number; // inclusive
    end: number; // inclusive
    partial: boolean; // true when a Range was requested and honored
}

// Parse an RFC 7233 single-range `bytes=` header against a known size. Returns the full range when
// absent or unsatisfiable (caller then responds 200, not 416, to keep media playback simple).
const parseRange = (rangeHeader: string | undefined, size: number): { start: number; end: number; partial: boolean } => {
    const full = { start: 0, end: Math.max(0, size - 1), partial: false };
    if (!rangeHeader || size === 0) return full;
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m) return full;
    const [, startStr, endStr] = m;
    let start: number;
    let end: number;
    if (startStr === '') {
        // Suffix range: last N bytes.
        const suffix = parseInt(endStr, 10);
        if (!Number.isFinite(suffix) || suffix <= 0) return full;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = parseInt(startStr, 10);
        end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return full;
    return { start, end: Math.min(end, size - 1), partial: true };
};

// Open a bounded read stream for raw bytes (media rendering + downloads), honoring an optional
// Range. Enforces the same symlink-free containment as every other op.
export const openFileStreamLocal = async (projectId: string, root: ParsedRoot, relPath: string, rangeHeader?: string): Promise<RawFileStream> => {
    let real: string;
    try {
        real = await resolveWithin(baseDirFor(projectId, root), relPath);
    } catch (e) {
        if (isMissing(e)) throw new FileAccessError('not_found', 'file not found');
        throw e;
    }
    const st = await fs.stat(real).catch((e) => {
        if (isMissing(e)) throw new FileAccessError('not_found', 'file not found');
        throw e;
    });
    if (!st.isFile()) throw new FileAccessError('not_a_file', 'not a regular file');
    if (st.size > RAW_STREAM_MAX) throw new FileAccessError('too_large', 'file exceeds the maximum streamable size');

    const { start, end, partial } = parseRange(rangeHeader, st.size);
    const cls = await classify(real, st.size);
    const stream = createReadStream(real, { start, end });
    return { stream, name: path.basename(real), mimeType: cls.mimeType, size: st.size, start, end, partial };
};
