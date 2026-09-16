import { Badge, Checkbox, Collapse, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { LogFacet } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdExpandLess, MdExpandMore } from 'react-icons/md';
import { colorForValue, levelInfo } from './logLevels';

// Map of field -> selected values. Empty/absent means no filter on that field.
export type Selections = Record<string, string[]>;

// Human label for a facet value (level numbers -> names; everything else verbatim).
const displayValue = (field: string, value: string): string => (field === 'level' ? levelInfo(value).name : value);

const FacetGroup = ({ facet, selected, onToggle }: { facet: LogFacet; selected: string[]; onToggle: (value: string) => void }) => {
    const [open, setOpen] = useState(true);
    return (
        <Stack gap={4}>
            <UnstyledButton onClick={() => setOpen((o) => !o)}>
                <Group gap={4} justify="space-between">
                    <Text fw={600} fz="sm" tt="capitalize">
                        {facet.field}
                    </Text>
                    {open ? <MdExpandLess /> : <MdExpandMore />}
                </Group>
            </UnstyledButton>
            <Collapse in={open}>
                <Stack gap={2}>
                    {facet.values.length === 0 && (
                        <Text fz="xs" c="dimmed">
                            No values
                        </Text>
                    )}
                    {facet.values.map((v) => {
                        const label = displayValue(facet.field, v.value);
                        const color = facet.field === 'level' ? levelInfo(v.value).color : colorForValue(v.value);
                        return (
                            <Group key={v.value} gap={6} wrap="nowrap" justify="space-between">
                                <Checkbox
                                    size="xs"
                                    checked={selected.includes(v.value)}
                                    onChange={() => onToggle(v.value)}
                                    label={
                                        <Group gap={6} wrap="nowrap">
                                            <Badge size="xs" variant="light" color={color}>
                                                {label}
                                            </Badge>
                                        </Group>
                                    }
                                    styles={{ label: { paddingInlineStart: 6 } }}
                                />
                                <Text fz="xs" c="dimmed">
                                    {v.count.toLocaleString()}
                                </Text>
                            </Group>
                        );
                    })}
                </Stack>
            </Collapse>
        </Stack>
    );
};

export const FacetSidebar = ({
    facets,
    selections,
    loading,
    onToggle,
}: {
    facets: LogFacet[];
    selections: Selections;
    loading: boolean;
    onToggle: (field: string, value: string) => void;
}) => {
    return (
        <Stack gap="md" w={220} style={{ flexShrink: 0 }}>
            <Group justify="space-between">
                <Text fw={700} fz="sm">
                    Filters
                </Text>
                {loading && <Loader size="xs" />}
            </Group>
            {facets.length === 0 && !loading && (
                <Text fz="xs" c="dimmed">
                    No facets for this selection.
                </Text>
            )}
            {facets.map((facet) => (
                <FacetGroup key={facet.field} facet={facet} selected={selections[facet.field] || []} onToggle={(value) => onToggle(facet.field, value)} />
            ))}
        </Stack>
    );
};
