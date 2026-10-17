import { useQuery } from '@tanstack/react-query';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { FileBrowseResult, FileContent } from '@mosaiq/nsm-common/types';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { logger } from '@/utils/logger';

// Same-origin by default (the leader serves the SPA and API together); mirrors utils/api.ts.
const API_BASE = import.meta.env.VITE_API_URL ?? '';
const TIMEOUT_MS = 30000;

// Carries the HTTP status so the UI can distinguish not-deployed (409), forbidden (403), too-large
// (413), not-found (404), etc. React Query surfaces it via the query's `error`.
export class FileApiError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'FileApiError';
    }
}

const withProject = (route: string, projectId: string): string => route.replace('/:projectId', `/${encodeURIComponent(projectId)}`);

const buildQuery = (query: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') search.set(k, v);
    const s = search.toString();
    return s ? `?${s}` : '';
};

const authedGet = async <T>(path: string, token: string, query: Record<string, string | undefined>): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new FileApiError(res.status, body || res.statusText);
    }
    return (await res.json()) as T;
};

// Browse a project's files. Pass rootId='' (the default) for the virtual top level, which returns
// the available roots and the project's workerNodeId without touching the worker node.
export const useProjectFiles = (projectId: string | undefined, rootId: string, path: string, enabled = true) => {
    const api = useAPI();
    return useQuery<FileBrowseResult>({
        queryKey: queryKeys.projectFiles(projectId ?? '', rootId, path),
        queryFn: () => authedGet<FileBrowseResult>(withProject(API_ROUTES.GET_PROJECT_FILES, projectId as string), api.token as string, { root: rootId || undefined, path: path || undefined }),
        enabled: !!api.token && !!projectId && enabled,
        retry: false, // surface 403/404/409 immediately instead of retrying
    });
};

// Read a single file's metadata + inline text (for media/binary, only metadata + previewAvailable).
export const useProjectFile = (projectId: string | undefined, rootId: string, path: string, enabled = true) => {
    const api = useAPI();
    return useQuery<FileContent>({
        queryKey: queryKeys.projectFile(projectId ?? '', rootId, path),
        queryFn: () => authedGet<FileContent>(withProject(API_ROUTES.GET_PROJECT_FILE, projectId as string), api.token as string, { root: rootId, path }),
        enabled: !!api.token && !!projectId && !!rootId && enabled,
        retry: false,
    });
};

// Fetch raw bytes (media rendering / downloads) via an authorized request -> Blob. The <img>/<video>
// tags can't carry an Authorization header, so we fetch here and hand back an object URL source.
export const fetchProjectFileBlob = async (token: string, projectId: string, rootId: string, path: string): Promise<Blob> => {
    try {
        const url = `${API_BASE}${withProject(API_ROUTES.GET_PROJECT_FILE_RAW, projectId)}${buildQuery({ root: rootId, path })}`;
        const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new FileApiError(res.status, body || res.statusText);
        }
        return await res.blob();
    } catch (e) {
        logger.error('api', 'raw file fetch failed', { err: e, projectId, rootId, path });
        throw e;
    }
};
