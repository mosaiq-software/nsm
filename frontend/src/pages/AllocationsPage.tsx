import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Alert, Anchor, Card, Center, Group, Loader, Stack, Text, Title, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ResourceAllocation } from '@mosaiq/nsm-common/types';
import { useAPI } from '@/utils/api';
import { useCluster } from '@/contexts/cluster-context';
import { AllocationStatusBadge, ResourceAllocationEditor, ResourceUsageBars } from '@/components/ResourceAllocation';
import { MdOutlineLaunch, MdOutlineRefresh } from 'react-icons/md';

const REFRESH_MS = 15000;

const AllocationsPage = () => {
    const api = useAPI();
    const clusterCtx = useCluster();
    const [allocations, setAllocations] = useState<ResourceAllocation[] | null>(null);
    const [loading, setLoading] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get(API_ROUTES.GET_RESOURCE_ALLOCATIONS, {});
            setAllocations(res ?? []);
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api.token]);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(interval);
    }, [refresh]);

    if (allocations === null) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }

    const sorted = [...allocations].sort((a, b) => a.projectId.localeCompare(b.projectId));

    return (
        <Stack>
            <Group justify="space-between" align="center">
                <Title order={3}>Resource Allocations</Title>
                <Tooltip label="Refresh">
                    <ActionIcon variant="light" size="lg" onClick={refresh} loading={loading}>
                        <MdOutlineRefresh />
                    </ActionIcon>
                </Tooltip>
            </Group>
            <Text c="dimmed" fz="sm">
                Set advisory CPU, memory, and storage allocations per project. Exceeding an allocation notifies all NSM admins and the project&apos;s team members, but never blocks the project.
            </Text>
            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Metrics unavailable">
                    Usage is served by the leader. No leader is currently reachable, so current usage may be missing.
                </Alert>
            )}
            {sorted.length === 0 ? (
                <Center py="xl">
                    <Text c="dimmed">No projects yet.</Text>
                </Center>
            ) : (
                sorted.map((a) => (
                    <Card key={a.projectId} withBorder>
                        <Stack gap="sm">
                            <Group justify="space-between" align="center">
                                <Group gap="xs" align="center">
                                    <Title order={5}>{a.projectId}</Title>
                                    <Text c="dimmed" fz="sm">
                                        {a.repoOwner}
                                    </Text>
                                    <Anchor component={Link} to={`/p/${a.projectId}/logs`} fz="sm">
                                        <Group gap={2} align="center">
                                            Logs <MdOutlineLaunch />
                                        </Group>
                                    </Anchor>
                                </Group>
                                <AllocationStatusBadge quota={a.quota} usage={a.usage} />
                            </Group>
                            <ResourceUsageBars quota={a.quota} usage={a.usage} />
                            <ResourceAllocationEditor projectId={a.projectId} quota={a.quota} onSaved={refresh} />
                        </Stack>
                    </Card>
                ))
            )}
        </Stack>
    );
};

export default AllocationsPage;
