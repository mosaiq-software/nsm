import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

vi.mock('@/cluster/node', () => ({ cluster: { leaderAddress: vi.fn() } }));

import { cluster } from '@/cluster/node';
import { config } from '@/config';
import { postToLeader, postToNode, forwardToLeader, CLUSTER_SECRET_HEADER } from '@/cluster/leaderClient';
import { installFetchMock, fakeResponse } from '../helpers/fetchMock';

const leaderAddress = cluster.leaderAddress as unknown as Mock;
let fetchMock: Mock;

beforeEach(() => {
    fetchMock = installFetchMock();
    leaderAddress.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const fakeRes = () => {
    const res: any = { statusCode: 0, headers: {} as Record<string, string>, body: undefined };
    res.status = vi.fn((c: number) => {
        res.statusCode = c;
        return res;
    });
    res.setHeader = vi.fn((k: string, v: string) => {
        res.headers[k] = v;
    });
    res.send = vi.fn((b: any) => {
        res.body = b;
    });
    return res;
};

describe('postToLeader', () => {
    it('returns null when there is no leader', async () => {
        leaderAddress.mockReturnValue(null);
        expect(await postToLeader('/x', {})).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts with the cluster secret header and parses the JSON response', async () => {
        leaderAddress.mockReturnValue('http://leader:1');
        fetchMock.mockResolvedValue(fakeResponse({ body: { ok: true } }));
        expect(await postToLeader('/x', { a: 1 })).toEqual({ ok: true });
        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers[CLUSTER_SECRET_HEADER]).toBe(config.clusterSecret);
    });

    it('returns null when the leader responds non-2xx', async () => {
        leaderAddress.mockReturnValue('http://leader:1');
        fetchMock.mockResolvedValue(fakeResponse({ status: 500, body: 'err' }));
        expect(await postToLeader('/x', {})).toBeNull();
    });
});

describe('postToNode', () => {
    it('parses a JSON response and returns null on empty body or error', async () => {
        fetchMock.mockResolvedValueOnce(fakeResponse({ body: { port: 1 } }));
        expect(await postToNode('1.2.3.4', 5, '/p', {})).toEqual({ port: 1 });
        fetchMock.mockResolvedValueOnce(fakeResponse({ body: '' }));
        expect(await postToNode('1.2.3.4', 5, '/p', {})).toBeNull();
        fetchMock.mockRejectedValueOnce(new Error('down'));
        expect(await postToNode('1.2.3.4', 5, '/p', {})).toBeNull();
    });
});

describe('forwardToLeader', () => {
    const req = (): any => ({ originalUrl: '/private/x', headers: { authorization: 'Bearer t' }, method: 'POST', body: { a: 1 } });

    it('responds 503 when there is no leader', async () => {
        leaderAddress.mockReturnValue(null);
        const res = fakeRes();
        await forwardToLeader(req(), res);
        expect(res.statusCode).toBe(503);
    });

    it('proxies the request to the leader and pipes back status + content-type', async () => {
        leaderAddress.mockReturnValue('http://leader:1');
        fetchMock.mockResolvedValue(fakeResponse({ status: 201, body: 'created', contentType: 'text/plain' }));
        const res = fakeRes();
        await forwardToLeader(req(), res);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://leader:1/private/x');
        expect(init.method).toBe('POST');
        expect(init.headers['Authorization']).toBe('Bearer t');
        expect(init.headers[CLUSTER_SECRET_HEADER]).toBe(config.clusterSecret);
        expect(res.statusCode).toBe(201);
        expect(res.headers['content-type']).toBe('text/plain');
        expect(res.body).toContain('created');
    });

    it('responds 502 when the leader is unreachable', async () => {
        leaderAddress.mockReturnValue('http://leader:1');
        fetchMock.mockRejectedValue(new Error('boom'));
        const res = fakeRes();
        await forwardToLeader(req(), res);
        expect(res.statusCode).toBe(502);
    });
});
