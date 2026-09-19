import { Chip, Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { describeRecurrence, RecurrenceFrequency, RecurrenceState, WEEKDAY_SHORT } from './recurrence';

const FREQUENCY_OPTIONS: { value: RecurrenceFrequency; label: string }[] = [
    { value: 'minutes', label: 'Every few minutes' },
    { value: 'hourly', label: 'Hourly' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
];

interface RecurrenceInputProps {
    value: RecurrenceState;
    onChange: (next: RecurrenceState) => void;
}

// Visual, human-readable schedule builder. Emits a RecurrenceState the parent turns into cron via
// buildCron; the raw cron pattern is never surfaced to the user.
export const RecurrenceInput = ({ value, onChange }: RecurrenceInputProps) => {
    const patch = (fields: Partial<RecurrenceState>) => onChange({ ...value, ...fields });

    const toNumber = (raw: number | string, fallback: number): number => {
        const num = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(num) ? num : fallback;
    };

    const showTime = value.frequency === 'daily' || value.frequency === 'weekly' || value.frequency === 'monthly';

    return (
        <Stack gap="xs" ml="xl">
            <Group align="flex-end" gap="sm" wrap="wrap">
                <Select
                    label="Repeats"
                    data={FREQUENCY_OPTIONS}
                    value={value.frequency}
                    onChange={(v) => v && patch({ frequency: v as RecurrenceFrequency })}
                    allowDeselect={false}
                    w="16ch"
                />

                {value.frequency === 'minutes' && (
                    <NumberInput label="Every (minutes)" min={1} max={59} value={value.everyN} onChange={(v) => patch({ everyN: toNumber(v, value.everyN) })} w="14ch" />
                )}

                {value.frequency === 'hourly' && (
                    <NumberInput label="At minute" min={0} max={59} value={value.minute} onChange={(v) => patch({ minute: toNumber(v, value.minute) })} w="12ch" />
                )}

                {value.frequency === 'monthly' && (
                    <NumberInput label="Day of month" min={1} max={31} value={value.dayOfMonth} onChange={(v) => patch({ dayOfMonth: toNumber(v, value.dayOfMonth) })} w="14ch" />
                )}

                {showTime && (
                    <Group gap={4} align="flex-end">
                        <NumberInput label="Time (UTC)" min={0} max={23} value={value.hour} onChange={(v) => patch({ hour: toNumber(v, value.hour) })} w="8ch" />
                        <Text pb={6}>:</Text>
                        <NumberInput aria-label="Minute" min={0} max={59} value={value.minute} onChange={(v) => patch({ minute: toNumber(v, value.minute) })} w="8ch" />
                    </Group>
                )}
            </Group>

            {value.frequency === 'weekly' && (
                <Chip.Group multiple value={value.weekdays.map((d) => String(d))} onChange={(v) => patch({ weekdays: v.map(Number) })}>
                    <Group gap={6}>
                        {WEEKDAY_SHORT.map((label, index) => (
                            <Chip key={index} value={String(index)} size="xs" variant="outline">
                                {label}
                            </Chip>
                        ))}
                    </Group>
                </Chip.Group>
            )}

            <Text size="sm" c="dimmed">
                {describeRecurrence(value)}
            </Text>
        </Stack>
    );
};

export default RecurrenceInput;
