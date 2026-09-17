import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { queryLogs, queryMetric, queryNsmLogs, queryStructuredLogs, queryLogFacets } from '@/controllers/observabilityController';
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

describe('queryStructuredLogs', () => {
    it('builds an nsmd query with search, json, field filter and level floor, newest-first', async () => {
        fetchMock.mockResolvedValue(
            ok({ data: { result: [{ stream: { source: 'nsmd' }, values: [['100', '{"level":30,"msg":"a"}'], ['300', '{"level":40,"msg":"b"}']] }] } })
        );
        const res = await queryStructuredLogs({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9', search: 'oops', filters: [{ field: 'area', op: 'eq', value: 'reconcile' }], levelMin: 40, limit: 200 });
        const url = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        expect(url).toContain('{source="nsmd"} |= "oops" | json | area="reconcile" | level >= 40');
        expect(res.entries.map((e) => e.ts)).toEqual(['300', '100']);
        expect(res.entries[0].fields).toEqual({ level: 40, msg: 'b' });
        expect(res.nextCursorNs).toBeUndefined();
    });

    it('builds a project query without json, using a label match filter', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [] } }));
        await queryStructuredLogs({ selector: { serviceInstanceId: 's1' }, startNs: '0', endNs: '9', filters: [{ field: 'serviceName', op: 'match', value: 'web|api' }] });
        const url = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        expect(url).toContain('{serviceInstanceId="s1"} | serviceName=~"web|api"');
        expect(url).not.toContain('| json');
    });

    it('escapes double quotes in the search term', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [] } }));
        await queryStructuredLogs({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9', search: 'say "hi"' });
        expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain('|= "say \\"hi\\""');
    });

    it('advertises a nextCursorNs one ns before the oldest when the page is full', async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [{ stream: {}, values: [['300', '{}'], ['200', '{}']] }] } }));
        const res = await queryStructuredLogs({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9', limit: 2 });
        expect(res.nextCursorNs).toBe('199');
    });
});

describe('queryLogFacets', () => {
    it('aggregates facet counts via count_over_time and sorts descending', async () => {
        fetchMock.mockResolvedValueOnce(ok({ data: { result: [{ metric: { area: 'reconcile' }, value: [0, '5'] }, { metric: { area: 'deploy' }, value: [0, '12'] }] } }));
        fetchMock.mockResolvedValueOnce(ok({ data: { result: [{ metric: {}, value: [0, '17'] }] } }));
        const res = await queryLogFacets({ selector: { source: 'nsmd' }, startNs: '0', endNs: '60000000000', fields: ['area'] });
        const url = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        expect(url).toContain('sum by (area) (count_over_time({source="nsmd"} | json [60s]))');
        expect(res.facets[0].values).toEqual([{ value: 'deploy', count: 12 }, { value: 'reconcile', count: 5 }]);
        expect(res.total).toBe(17);
    });

    it("excludes a field's own selections from its facet counts but keeps other groups' filters", async () => {
        fetchMock.mockResolvedValue(ok({ data: { result: [] } }));
        await queryLogFacets({
            selector: { source: 'nsmd' },
            startNs: '0',
            endNs: '60000000000',
            fields: ['level', 'area'],
            filters: [
                { field: 'level', op: 'match', value: '20|50' },
                { field: 'area', op: 'eq', value: 'push' },
            ],
            levelMin: 30,
        });
        const levelUrl = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
        const areaUrl = decodeURIComponent(fetchMock.mock.calls[1][0] as string);
        // The level facet drops the level selection AND the level floor, but keeps the area filter.
        expect(levelUrl).toContain('sum by (level) (count_over_time({source="nsmd"} | json | area="push" [60s]))');
        expect(levelUrl).not.toContain('level=~');
        expect(levelUrl).not.toContain('level >=');
        // The area facet drops the area selection but keeps the level filters (from other groups).
        expect(areaUrl).toContain('sum by (area) (count_over_time({source="nsmd"} | json | level=~"20|50" | level >= 30 [60s]))');
        expect(areaUrl).not.toContain('area=');
        // Total applies every filter (all groups ANDed).
        const totalUrl = decodeURIComponent(fetchMock.mock.calls[2][0] as string);
        expect(totalUrl).toContain('sum (count_over_time({source="nsmd"} | json | level=~"20|50" | area="push" | level >= 30 [60s]))');
    });

    it('rejects field names that are not identifiers (injection guard)', async () => {
        await expect(queryLogFacets({ selector: { source: 'nsmd' }, startNs: '0', endNs: '9', fields: ['area; bad'] })).rejects.toThrow(/invalid field/);
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
