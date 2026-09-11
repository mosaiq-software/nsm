import { vi } from 'vitest';

export interface FakeResponseInit {
    status?: number;
    body?: any;
    contentType?: string;
}

// Build a minimal object matching what leaderClient/authUtils read off a fetch Response.
export const fakeResponse = (init: FakeResponseInit = {}) => {
    const status = init.status ?? 200;
    const bodyText = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {});
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => bodyText,
        json: async () => (typeof init.body === 'string' ? JSON.parse(init.body) : init.body),
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? init.contentType ?? 'application/json' : null) },
    };
};

// Install a fetch stub; returns the mock so tests can assert calls / queue responses.
export const installFetchMock = () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    return fn;
};
