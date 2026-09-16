import { ActionIcon, Badge, Code, CopyButton, Drawer, Group, ScrollArea, Stack, Table, Text, Tooltip } from '@mantine/core';
import { LogEntry } from '@mosaiq/nsm-common/types';
import { MdContentCopy, MdFilterAlt, MdCheck } from 'react-icons/md';
import { levelInfo } from './logLevels';

const stringify = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

// One key/value row with a copy + "filter by this value" affordance. Non-filterable rows (objects)
// omit the filter button.
const KvRow = ({ field, value, onFilter }: { field: string; value: unknown; onFilter?: (field: string, value: string) => void }) => {
    const str = stringify(value);
    const filterable = onFilter && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
    return (
        <Table.Tr>
            <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <Text fz="xs" fw={600} c="dimmed">
                    {field}
                </Text>
            </Table.Td>
            <Table.Td>
                <Group gap={6} wrap="nowrap" justify="space-between" align="flex-start">
                    <Text fz="xs" ff="monospace" style={{ wordBreak: 'break-word' }}>
                        {str}
                    </Text>
                    {filterable && (
                        <Tooltip label={`Filter by ${field}`}>
                            <ActionIcon size="xs" variant="subtle" onClick={() => onFilter!(field, String(value))}>
                                <MdFilterAlt />
                            </ActionIcon>
                        </Tooltip>
                    )}
                </Group>
            </Table.Td>
        </Table.Tr>
    );
};

export const LogDetailDrawer = ({
    entry,
    facetFields,
    onClose,
    onFilter,
}: {
    entry: LogEntry | null;
    facetFields: string[];
    onClose: () => void;
    onFilter: (field: string, value: string) => void;
}) => {
    const fields = entry?.fields ?? {};
    const labels = entry?.labels ?? {};
    const lvl = levelInfo((fields as any).level);
    const pretty = entry ? (entry.fields ? JSON.stringify(entry.fields, null, 2) : entry.line) : '';

    return (
        <Drawer opened={!!entry} onClose={onClose} position="right" size="lg" title="Log details" scrollAreaComponent={ScrollArea.Autosize}>
            {entry && (
                <Stack gap="md">
                    <Group gap="xs">
                        {fields && (fields as any).level != null && (
                            <Badge variant="light" color={lvl.color}>
                                {lvl.name}
                            </Badge>
                        )}
                        <Text fz="sm" c="dimmed">
                            {new Date(Number(entry.ts) / 1_000_000).toLocaleString()}
                        </Text>
                    </Group>

                    {entry.fields && (
                        <Stack gap={4}>
                            <Text fw={700} fz="sm">
                                Fields
                            </Text>
                            <Table withRowBorders={false} verticalSpacing={2}>
                                <Table.Tbody>
                                    {Object.entries(entry.fields).map(([k, v]) => (
                                        <KvRow key={k} field={k} value={v} onFilter={facetFields.includes(k) || typeof v !== 'object' ? onFilter : undefined} />
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Stack>
                    )}

                    {Object.keys(labels).length > 0 && (
                        <Stack gap={4}>
                            <Text fw={700} fz="sm">
                                Stream labels
                            </Text>
                            <Table withRowBorders={false} verticalSpacing={2}>
                                <Table.Tbody>
                                    {Object.entries(labels).map(([k, v]) => (
                                        <KvRow key={k} field={k} value={v} onFilter={onFilter} />
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Stack>
                    )}

                    <Stack gap={4}>
                        <Group justify="space-between">
                            <Text fw={700} fz="sm">
                                Raw
                            </Text>
                            <CopyButton value={pretty}>
                                {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied' : 'Copy'}>
                                        <ActionIcon size="sm" variant="subtle" onClick={copy}>
                                            {copied ? <MdCheck /> : <MdContentCopy />}
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </CopyButton>
                        </Group>
                        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {pretty}
                        </Code>
                    </Stack>
                </Stack>
            )}
        </Drawer>
    );
};
