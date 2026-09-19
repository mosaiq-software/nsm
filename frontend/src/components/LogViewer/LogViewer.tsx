import { ActionIcon, Badge, Card, Group, Select, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { LogEntry, LogFilter, LogSelector } from '@mosaiq/nsm-common/types';
import { useMemo, useState } from 'react';
import { MdClose, MdOutlineRefresh, MdOutlineSearch } from 'react-icons/md';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { FacetSidebar, Selections } from './FacetSidebar';
import { LogTable } from './LogTable';
import { LogDetailDrawer } from './LogDetailDrawer';
import { levelInfo } from './logLevels';
import { resolveRange, TimeRange, TimeRangeControl } from './TimeRangeControl';

const PAGE_SIZE = 200;
const LIVE_INTERVAL_MS = 10_000;

// Minimum pino level options ("this level and above"). Empty value clears the floor.
const LEVEL_MIN_OPTIONS = [
    { value: '', label: 'All levels' },
    { value: '20', label: 'Debug and up' },
    { value: '30', label: 'Info and up' },
    { value: '40', label: 'Warn and up' },
    { value: '50', label: 'Error and up' },
];

export interface LogViewerProps {
    selector: LogSelector;
    facetFields: string[];
    defaultColumns?: string[];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Collapse the facet selections into LogQL filters: one eq per single value, a regex-match for
// multiple values of the same field (OR semantics).
const selectionsToFilters = (sel: Selections): LogFilter[] => {
    const out: LogFilter[] = [];
    for (const [field, vals] of Object.entries(sel)) {
        if (!vals || vals.length === 0) continue;
        if (vals.length === 1) out.push({ field, op: 'eq', value: vals[0] });
        else out.push({ field, op: 'match', value: vals.map(escapeRegex).join('|') });
    }
    return out;
};

const boundsNs = (range: TimeRange): { startNs: string; endNs: string } => {
    const { startMs, endMs } = resolveRange(range);
    return { startNs: `${startMs * 1_000_000}`, endNs: `${endMs * 1_000_000}` };
};

export const LogViewer = ({ selector, facetFields, defaultColumns }: LogViewerProps) => {
    const api = useAPI();
    const columns = defaultColumns ?? ['ts', 'level', 'msg'];

    const [range, setRange] = useState<TimeRange>({ mode: 'preset', presetMs: 60 * 60 * 1000 });
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch] = useDebouncedValue(searchInput, 300);
    const [selections, setSelections] = useState<Selections>({});
    const [levelMin, setLevelMin] = useState<number | undefined>(undefined);
    const [selected, setSelected] = useState<LogEntry | null>(null);
    const [live, setLive] = useState(true);

    const selectorKey = JSON.stringify(selector);
    const selectionsKey = JSON.stringify(selections);
    const rangeKey = range.mode === 'preset' ? `p:${range.presetMs}` : `c:${range.startMs}-${range.endMs}`;
    const filters = useMemo(() => selectionsToFilters(selections), [selectionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const search = debouncedSearch || undefined;

    // Live tailing only makes sense for now-relative preset ranges.
    const livePreset = live && range.mode === 'preset';
    // Stable inputs identity: every input that changes the query result contributes a segment.
    const inputsKey = `${selectorKey}|${debouncedSearch}|${selectionsKey}|${levelMin ?? ''}|${rangeKey}`;

    const entriesQuery = useInfiniteQuery({
        queryKey: queryKeys.logs(inputsKey),
        queryFn: async ({ pageParam }) => {
            const { startNs, endNs } = boundsNs(range);
            return (
                (await api.post(API_ROUTES.POST_LOG_QUERY, {}, {
                    selector,
                    startNs,
                    endNs,
                    search,
                    filters,
                    levelMin,
                    limit: PAGE_SIZE,
                    cursorNs: pageParam,
                })) ?? { entries: [], nextCursorNs: undefined }
            );
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => lastPage.nextCursorNs,
        placeholderData: keepPreviousData,
        enabled: !!api.token,
        refetchInterval: livePreset ? LIVE_INTERVAL_MS : false,
    });

    const facetsQuery = useQuery({
        queryKey: queryKeys.logFacets(inputsKey),
        queryFn: async () => {
            const { startNs, endNs } = boundsNs(range);
            return (
                (await api.post(API_ROUTES.POST_LOG_FACETS, {}, {
                    selector,
                    startNs,
                    endNs,
                    search,
                    filters,
                    levelMin,
                    fields: facetFields,
                })) ?? { facets: [], total: 0 }
            );
        },
        placeholderData: keepPreviousData,
        enabled: !!api.token && facetFields.length > 0,
        refetchInterval: livePreset ? LIVE_INTERVAL_MS : false,
    });

    const entries = useMemo(() => entriesQuery.data?.pages.flatMap((p) => p.entries) ?? [], [entriesQuery.data]);
    const facets = facetsQuery.data?.facets ?? [];
    const total = facetsQuery.data?.total ?? 0;
    const loading = entriesQuery.isFetching && !entriesQuery.isFetchingNextPage;
    const loadingMore = entriesQuery.isFetchingNextPage;
    const facetsLoading = facetsQuery.isFetching;

    const refreshAll = () => {
        void entriesQuery.refetch();
        void facetsQuery.refetch();
    };

    const toggleSelection = (field: string, value: string) => {
        setSelections((prev) => {
            const cur = prev[field] || [];
            const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
            const copy = { ...prev };
            if (next.length) copy[field] = next;
            else delete copy[field];
            return copy;
        });
    };

    const activeFilterCount = Object.values(selections).reduce((n, vals) => n + vals.length, 0);

    return (
        <Stack gap="sm">
            <Group align="flex-end" justify="space-between">
                <TextInput
                    label="Search"
                    placeholder="Filter log text (LogQL contains)"
                    leftSection={<MdOutlineSearch />}
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.currentTarget.value)}
                    w={360}
                    rightSection={
                        searchInput ? (
                            <ActionIcon variant="subtle" size="sm" onClick={() => setSearchInput('')}>
                                <MdClose />
                            </ActionIcon>
                        ) : null
                    }
                />
                <Group align="flex-end" gap="md">
                    {facetFields.includes('level') && (
                        <Select
                            label="Level"
                            data={LEVEL_MIN_OPTIONS}
                            value={levelMin != null ? String(levelMin) : ''}
                            onChange={(v) => setLevelMin(v ? Number(v) : undefined)}
                            w={150}
                            allowDeselect={false}
                            comboboxProps={{ withinPortal: true }}
                        />
                    )}
                    <TimeRangeControl value={range} onChange={setRange} />
                    <Switch label="Live" checked={live} onChange={(e) => setLive(e.currentTarget.checked)} disabled={range.mode !== 'preset'} />
                    <Tooltip label="Refresh">
                        <ActionIcon variant="light" size="lg" loading={loading} onClick={refreshAll}>
                            <MdOutlineRefresh />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>

            <Group justify="space-between">
                <Text fz="sm" c="dimmed">
                    {total.toLocaleString()} events in range
                </Text>
                {activeFilterCount > 0 && (
                    <Group gap={6}>
                        {Object.entries(selections).flatMap(([field, vals]) =>
                            vals.map((v) => (
                                <Badge key={`${field}:${v}`} variant="light" rightSection={<MdClose size={12} style={{ cursor: 'pointer' }} onClick={() => toggleSelection(field, v)} />}>
                                    {field}: {field === 'level' ? levelInfo(v).name : v}
                                </Badge>
                            ))
                        )}
                        <Badge color="gray" variant="subtle" style={{ cursor: 'pointer' }} onClick={() => setSelections({})}>
                            Clear all
                        </Badge>
                    </Group>
                )}
            </Group>

            <Card withBorder p="sm">
                <Group align="flex-start" gap="md" wrap="nowrap">
                    <FacetSidebar facets={facets} selections={selections} loading={facetsLoading} onToggle={toggleSelection} />
                    <LogTable
                        entries={entries}
                        columns={columns}
                        loading={loading}
                        hasMore={!!entriesQuery.hasNextPage}
                        loadingMore={loadingMore}
                        onLoadMore={() => void entriesQuery.fetchNextPage()}
                        onSelect={setSelected}
                        selectedTs={selected?.ts}
                    />
                </Group>
            </Card>

            <LogDetailDrawer entry={selected} facetFields={facetFields} onClose={() => setSelected(null)} onFilter={toggleSelection} />
        </Stack>
    );
};

export default LogViewer;
