import { useUser } from '@/contexts/user-context';
import { API_BODY, API_PARAMS, API_RETURN, API_ROUTES } from '@mosaiq/nsm-common/routes';
import { logger } from '@/utils/logger';

const TIMEOUT_MS = 15000;

// Same-origin by default: the leader daemon serves this SPA and the API on one port. VITE_API_URL
// only needs to be set when pointing a standalone dev build at a remote leader.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

type QueryParams = Record<string, string | number | boolean | undefined>;

function buildQuery(query?: QueryParams): string {
    if (!query) return '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        search.set(key, String(value));
    }
    const str = search.toString();
    return str ? `?${str}` : '';
}

async function apiGet<T extends API_ROUTES>(route: T, params: API_PARAMS[T], authToken?: string, query?: QueryParams): Promise<API_RETURN[T] | undefined> {
    try {
        if (!authToken) {
            return undefined;
        }
        const loadedURL = loadParams(route, params);
        const response = await fetch(`${API_BASE}${loadedURL}${buildQuery(query)}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${authToken}`,
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            logger.warn('api', `GET ${route} responded ${response.status}`, { route: String(route), params, status: response.status });
        }
        const data = (await response.json()) as API_RETURN[T] | undefined;
        return data;
    } catch (e) {
        logger.error('api', `GET ${route} failed`, { err: e, route: String(route), params });
        return undefined;
    }
}

async function apiPost<T extends API_ROUTES>(route: T, params: API_PARAMS[T], body: API_BODY[T], authToken?: string): Promise<API_RETURN[T] | undefined> {
    try {
        if (!authToken) {
            return undefined;
        }
        const loadedURL = loadParams(route, params);
        const response = await fetch(`${API_BASE}${loadedURL}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : '{}',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            logger.warn('api', `POST ${route} responded ${response.status}`, { route: String(route), params, status: response.status });
        }
        const data = (await response.json()) as API_RETURN[T] | undefined;
        return data;
    } catch (e) {
        logger.error('api', `POST ${route} failed`, { err: e, route: String(route), params });
        return undefined;
    }
}

function loadParams<T extends API_ROUTES>(route: T, params: API_PARAMS[T]): T {
    let r = route as string;
    for (const param in params) {
        r = r.replace(`/:${param}`, `/${String(params[param as keyof API_PARAMS[T]])}`);
    }
    return r as T;
}

export const useAPI = () => {
    const userCtx = useUser();

    const get = async <T extends API_ROUTES>(route: T, params: API_PARAMS[T], query?: QueryParams) => {
        return apiGet(route, params, userCtx?.user?.authToken, query);
    };

    const post = async <T extends API_ROUTES>(route: T, params: API_PARAMS[T], body: API_BODY[T]) => {
        return apiPost(route, params, body, userCtx?.user?.authToken);
    };

    return {
        get,
        post,
        token: userCtx?.user?.authToken,
    };
};

export { apiGet as rawApiGetNoHook, apiPost as rawApiPostNoHook };
