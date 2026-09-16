import { Badge, Box, Button, Center, Group, Loader, ScrollArea, Table, Text } from '@mantine/core';
import { LogEntry } from '@mosaiq/nsm-common/types';
import { levelInfo } from './logLevels';

// Extract a display value for a column from an entry: known meta columns map to fields/labels,
// everything else is looked up in the parsed JSON fields then Loki labels.
const cellValue = (entry: LogEntry, column: string): string => {
    if (column === 'ts') return new Date(Number(entry.ts) / 1_000_000).toLocaleString();
    if (column === 'msg') {
        const f = entry.fields;
        if (f && typeof f.msg === 'string') return f.msg;
        return entry.line;
    }
    const fromFields = entry.fields?.[column];
    if (fromFields != null) return typeof fromFields === 'string' ? fromFields : JSON.stringify(fromFields);
    return entry.labels?.[column] ?? '';
};

const HEADER: Record<string, string> = { ts: 'Time', level: 'Level', area: 'Area', action: 'Action', msg: 'Message' };

export const LogTable = ({
    entries,
    columns,
    loading,
    hasMore,
    loadingMore,
    onLoadMore,
    onSelect,
    selectedTs,
}: {
    entries: LogEntry[];
    columns: string[];
    loading: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    onSelect: (entry: LogEntry) => void;
    selectedTs?: string;
}) => {
    if (loading && entries.length === 0) {
        return (
            <Center py="xl" style={{ flex: 1 }}>
                <Loader />
            </Center>
        );
    }
    if (entries.length === 0) {
        return (
            <Center py="xl" style={{ flex: 1 }}>
                <Text c="dimmed">No logs for this selection.</Text>
            </Center>
        );
    }

    return (
        <ScrollArea.Autosize mah={640} type="auto" style={{ flex: 1 }}>
            <Table stickyHeader highlightOnHover fz="xs" striped withRowBorders={false}>
                <Table.Thead>
                    <Table.Tr>
                        {columns.map((c) => (
                            <Table.Th key={c}>{HEADER[c] ?? c}</Table.Th>
                        ))}
                    </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                    {entries.map((entry, i) => {
                        const lvl = levelInfo(entry.fields?.level);
                        const isSelected = selectedTs === entry.ts;
                        return (
                            <Table.Tr
                                key={`${entry.ts}-${i}`}
                                onClick={() => onSelect(entry)}
                                style={{ cursor: 'pointer', background: isSelected ? 'var(--mantine-color-blue-light)' : undefined }}
                            >
                                {columns.map((c) => {
                                    if (c === 'level') {
                                        return (
                                            <Table.Td key={c}>
                                                <Box style={{ borderInlineStart: `3px solid var(--mantine-color-${lvl.color}-6)`, paddingInlineStart: 8 }}>
                                                    <Badge size="xs" variant="light" color={lvl.color}>
                                                        {lvl.name}
                                                    </Badge>
                                                </Box>
                                            </Table.Td>
                                        );
                                    }
                                    const val = cellValue(entry, c);
                                    return (
                                        <Table.Td key={c} style={c === 'msg' ? { maxWidth: 640 } : { whiteSpace: 'nowrap' }}>
                                            <Text fz="xs" lineClamp={c === 'msg' ? 1 : undefined} ff={c === 'msg' ? 'monospace' : undefined}>
                                                {val}
                                            </Text>
                                        </Table.Td>
                                    );
                                })}
                            </Table.Tr>
                        );
                    })}
                </Table.Tbody>
            </Table>
            {hasMore && (
                <Group justify="center" py="sm">
                    <Button size="xs" variant="light" loading={loadingMore} onClick={onLoadMore}>
                        Load older
                    </Button>
                </Group>
            )}
        </ScrollArea.Autosize>
    );
};
