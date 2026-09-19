import { Button, Group, NumberInput, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ProjectResourceQuota, ProjectResourceUsage } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useSetProjectQuota } from '@/hooks/mutations/projectMutations';
import { formatBytes, formatCores } from '@/utils/format';

export const GIB = 1024 ** 3;

// Canonical bytes <-> GB (GiB) used by the number inputs. Empty/undefined round-trips as undefined
// so an untouched field means "no allocation" for that resource.
export const bytesToGiB = (bytes: number | undefined): number | undefined => (bytes === undefined ? undefined : bytes / GIB);
export const giBToBytes = (gib: number | string | undefined): number | undefined => {
    if (gib === undefined || gib === '') return undefined;
    const n = Number(gib);
    return Number.isFinite(n) ? n * GIB : undefined;
};

const numberOrUndefined = (v: number | string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

interface UsageBarProps {
    label: string;
    used: number;
    limit: number | undefined;
    format: (n: number) => string;
}

const UsageBar = ({ label, used, limit, format }: UsageBarProps) => {
    const hasLimit = limit !== undefined && limit > 0;
    const fraction = hasLimit ? used / (limit as number) : 0;
    const over = hasLimit && used > (limit as number);
    const pct = hasLimit ? Math.min(100, fraction * 100) : 0;
    return (
        <Stack gap={2}>
            <Group justify="space-between" gap="xs">
                <Text fz="sm" fw={500}>
                    {label}
                </Text>
                <Text fz="sm" c={over ? 'red' : 'dimmed'}>
                    {format(used)}
                    {hasLimit ? ` / ${format(limit as number)}` : ' / no allocation'}
                    {hasLimit ? ` (${Math.round(fraction * 100)}%)` : ''}
                </Text>
            </Group>
            <Progress value={pct} color={over ? 'red' : 'blue'} size="lg" radius="sm" />
        </Stack>
    );
};

// Read-only usage-vs-allocation bars for the three resources. Visible to all project viewers.
export const ResourceUsageBars = ({ quota, usage }: { quota: ProjectResourceQuota | undefined; usage: ProjectResourceUsage | undefined }) => {
    const u = usage ?? { cpuCores: 0, memoryBytes: 0, storageBytes: 0 };
    const hasAnyQuota = !!quota && (quota.cpuCores !== undefined || quota.memoryBytes !== undefined || quota.storageBytes !== undefined);
    return (
        <Stack gap="sm">
            {!hasAnyQuota && (
                <Text fz="sm" c="dimmed">
                    No resource allocation has been set for this project.
                </Text>
            )}
            <UsageBar label="CPU (cores)" used={u.cpuCores} limit={quota?.cpuCores} format={formatCores} />
            <UsageBar label="Memory" used={u.memoryBytes} limit={quota?.memoryBytes} format={formatBytes} />
            <UsageBar label="Storage" used={u.storageBytes} limit={quota?.storageBytes} format={formatBytes} />
        </Stack>
    );
};

interface EditorProps {
    projectId: string;
    quota: ProjectResourceQuota | undefined;
    onSaved?: () => void | Promise<void>;
}

// Admin-only editor for a project's advisory allocation. CPU is entered in cores, memory and storage
// in GB. Leaving a field blank clears that resource's allocation. Saves via the dedicated endpoint.
export const ResourceAllocationEditor = ({ projectId, quota, onSaved }: EditorProps) => {
    const setQuota = useSetProjectQuota(projectId);
    const [cpuCores, setCpuCores] = useState<number | string>('');
    const [memGiB, setMemGiB] = useState<number | string>('');
    const [storageGiB, setStorageGiB] = useState<number | string>('');
    const saving = setQuota.isPending;

    useEffect(() => {
        setCpuCores(quota?.cpuCores ?? '');
        setMemGiB(bytesToGiB(quota?.memoryBytes) ?? '');
        setStorageGiB(bytesToGiB(quota?.storageBytes) ?? '');
    }, [projectId, quota?.cpuCores, quota?.memoryBytes, quota?.storageBytes]);

    const save = async () => {
        try {
            const body: ProjectResourceQuota = {
                cpuCores: numberOrUndefined(cpuCores),
                memoryBytes: giBToBytes(memGiB),
                storageBytes: giBToBytes(storageGiB),
            };
            await setQuota.mutateAsync(body);
            notifications.show({ title: 'Saved', message: 'Resource allocation updated', color: 'green' });
            await onSaved?.();
        } catch (e) {
            notifications.show({ title: 'Error', message: 'Failed to update allocation', color: 'red' });
        }
    };

    return (
        <Stack gap="sm">
            <Group align="flex-end" gap="md" wrap="wrap">
                <NumberInput label="CPU (cores)" placeholder="Unlimited" value={cpuCores} onChange={setCpuCores} min={0} step={0.5} decimalScale={2} w={140} />
                <NumberInput label="Memory (GB)" placeholder="Unlimited" value={memGiB} onChange={setMemGiB} min={0} step={0.5} decimalScale={2} w={140} />
                <NumberInput label="Storage (GB)" placeholder="Unlimited" value={storageGiB} onChange={setStorageGiB} min={0} step={1} decimalScale={2} w={140} />
                <Button onClick={save} loading={saving}>
                    Save
                </Button>
            </Group>
            <Text fz="xs" c="dimmed">
                Allocations are advisory: exceeding one notifies NSM admins and the project&apos;s team but never blocks the project. Leave a field blank to remove its allocation.
            </Text>
        </Stack>
    );
};
