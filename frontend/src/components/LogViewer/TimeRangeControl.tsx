import { Button, Group, Popover, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { MdOutlineSchedule } from 'react-icons/md';

// A relative preset (now - ms) or an absolute custom window. The parent resolves relative presets to
// concrete start/end at query time so "live" keeps sliding.
export type TimeRange = { mode: 'preset'; presetMs: number } | { mode: 'custom'; startMs: number; endMs: number };

const PRESETS: { label: string; ms: number }[] = [
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

// Resolve a range to concrete epoch-ms bounds (now-relative for presets).
export const resolveRange = (r: TimeRange): { startMs: number; endMs: number } => {
    if (r.mode === 'preset') {
        const end = Date.now();
        return { startMs: end - r.presetMs, endMs: end };
    }
    return { startMs: r.startMs, endMs: r.endMs };
};

// datetime-local <-> epoch ms (local time), avoiding an extra date-picker dependency.
const toLocalInput = (ms: number): string => {
    const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v: string): number => new Date(v).getTime();

export const TimeRangeControl = ({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) => {
    const [opened, setOpened] = useState(false);
    const now = Date.now();
    const [startStr, setStartStr] = useState(toLocalInput(value.mode === 'custom' ? value.startMs : now - 3600_000));
    const [endStr, setEndStr] = useState(toLocalInput(value.mode === 'custom' ? value.endMs : now));

    return (
        <Group gap="xs" align="flex-end">
            <Stack gap={2}>
                <Text fz="var(--input-label-size, var(--mantine-font-size-sm))">Time range</Text>
                <SegmentedControl
                    value={value.mode === 'preset' ? String(value.presetMs) : 'custom'}
                    onChange={(v) => {
                        if (v === 'custom') setOpened(true);
                        else onChange({ mode: 'preset', presetMs: Number(v) });
                    }}
                    data={[...PRESETS.map((p) => ({ value: String(p.ms), label: p.label })), { value: 'custom', label: 'Custom' }]}
                />
            </Stack>
            <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md" trapFocus>
                <Popover.Target>
                    <Button variant="light" leftSection={<MdOutlineSchedule />} onClick={() => setOpened((o) => !o)}>
                        {value.mode === 'custom' ? `${new Date(value.startMs).toLocaleString()} - ${new Date(value.endMs).toLocaleString()}` : 'Custom'}
                    </Button>
                </Popover.Target>
                <Popover.Dropdown>
                    <Stack gap="sm">
                        <TextInput label="From" type="datetime-local" value={startStr} onChange={(e) => setStartStr(e.currentTarget.value)} />
                        <TextInput label="To" type="datetime-local" value={endStr} onChange={(e) => setEndStr(e.currentTarget.value)} />
                        <Group justify="flex-end">
                            <Button
                                size="xs"
                                onClick={() => {
                                    const startMs = fromLocalInput(startStr);
                                    const endMs = fromLocalInput(endStr);
                                    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && startMs < endMs) {
                                        onChange({ mode: 'custom', startMs, endMs });
                                        setOpened(false);
                                    }
                                }}
                            >
                                Apply
                            </Button>
                        </Group>
                    </Stack>
                </Popover.Dropdown>
            </Popover>
        </Group>
    );
};
