import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { queryLogs, queryMetric, queryNsmLogs } from '@/controllers/observabilityController';
import { config } from '@/config';

let fetchMock: Mock;
beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    config.lokiUrl = 'http://loki:3100';
    config.prometheusUrl = 'http://prom:9090';
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: any): any => ({ ok: true, status: 200, json: async () => body });

describe('queryLogs', () => {
    it('builds a Loki selector by precedence and flattens streams newest-first', async () => {
        fetchMock.mockResolvedValue(
            ok({
                data: {
                    result: [
                        { stream: { serviceInstanceId: 's1' }, values: [['100', 'older'], ['300', 'newest']] },
                        { stream: { serviceInstanceId: 's1' }, values: [['200', 'middle']] },
                    ],
                },
            })
        );
        const res = await queryLogs({ serviceInstanceId: 's1', projectInstanceId: 'pi' }, '0', '9', 100);
        // serviceInstanceId wins over projectInstanceId.
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toContain('http://loki:3100/loki/api/v1/query_range');
        expect(decodeURIComponent(url)).toContain('{serviceInstanceId="s1"}');
        expect(res.lines.map((l) => l.line)).toEqual(['newest', 'middle', 'older']);
    });

    it('throws when no selector is provided', async () => {
        await expect(queryLogs({}, '0', '9')).rejects.toThrow(/selector/);
    });

    it('throws on a non-ok Loki response', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
        await expect(queryLogs({ projectId: 'p' }, '0', '9')).rejects.toThrow(/loki 503/);
    });
});

describe('queryNsmLogs', () => {
    it('builds a source="nsmd" selector across all nodes when no nodeId is given', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [{ stream: { source: 'nsmd' }, values: [['100', 'older'], ['200', 'newest']] }] } }));
        const res = await queryNsmLogs(undefined, '0', '9', 100);
        const url = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        expect(url).toContain('http://loki:3100/loki/api/v1/query_range');
        expect(url).toContain('{source="nsmd"}');
        expect(res.lines.map((l) => l.line)).toEqual(['newest', 'older']);
    });

    it('restricts to a single node when nodeId is given', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [] } }));
        await queryNsmLogs('node-a', '0', '9');
        expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain('{source="nsmd",nodeId="node-a"}');
    });

    it('throws on a non-ok Loki response', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
        await expect(queryNsmLogs(undefined, '0', '9')).rejects.toThrow(/loki 503/);
    });
});

describe('queryMetric', () => {
    it('builds a PromQL range query for the selected metric and parses series', async () => {
        fetchMock.mockResolvedValue(
            ok({ data: { result: [{ metric: { projectInstanceId: 'pi' }, values: [[100, '1.5'], [130, '2.5']] }] } })
        );
        const res = await queryMetric({ projectInstanceId: 'pi' }, 'cpu', '100', '200', '30s');
        const url = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        expect(url).toContain('http://prom:9090/api/v1/query_range');
        expect(url).toContain('container_cpu_usage_seconds_total{projectInstanceId="pi"}');
        expect(res.metric).toBe('cpu');
        expect(res.series[0].values).toEqual([{ t: 100, v: 1.5 }, { t: 130, v: 2.5 }]);
    });

    it('supports mem and net metric expressions', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [] } }));
        await queryMetric({ projectId: 'p' }, 'mem', '0', '9');
        expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain('container_memory_usage_bytes{projectId="p"}');
        await queryMetric({ projectId: 'p' }, 'net', '0', '9');
        expect(decodeURIComponent(fetchMock.mock.calls[1][0] as string)).toContain('container_network_receive_bytes_total{projectId="p"}');
    });
});
