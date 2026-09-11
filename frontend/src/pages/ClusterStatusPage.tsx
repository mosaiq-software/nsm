import { Alert, Badge, Card, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useCluster } from '@/contexts/cluster-context';

const ClusterStatusPage = () => {
    const clusterCtx = useCluster();
    const status = clusterCtx.status;

    const reachableCount = status?.health.filter((h) => h.reachable).length ?? 0;
    const totalCount = status?.nodes.length ?? clusterCtx.nodes.length;

    return (
        <Stack>
            <Title order={2}>Cluster Status</Title>
            {!clusterCtx.hasLeader && (
                <Alert color="red" variant="light" title="No Leader">
                    No leader node is currently reachable.
                </Alert>
            )}
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            Leader
                        </Text>
                        <Text fw={600}>{status?.leaderId ?? clusterCtx.leader?.nodeId ?? 'None'}</Text>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            Nodes Reachable
                        </Text>
                        <Text fw={600}>
                            {reachableCount} / {totalCount}
                        </Text>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            Desired NSM Version
                        </Text>
                        <Text fw={600}>{status?.desiredNsmVersion ?? '—'}</Text>
                    </Stack>
                </Card>
            </SimpleGrid>
            <Title order={4}>Node Health</Title>
            {status && status.health.length > 0 ? (
                <Table>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Node ID</Table.Th>
                            <Table.Th>Role</Table.Th>
                            <Table.Th>Reachable</Table.Th>
                            <Table.Th>NSM Version</Table.Th>
                            <Table.Th>Version Match</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {status.health.map((h) => {
                            const matches = status.desiredNsmVersion ? h.nsmVersion === status.desiredNsmVersion : true;
                            return (
                                <Table.Tr key={h.nodeId}>
                                    <Table.Td>
                                        <Group gap={6}>
                                            <Text fw={600}>{h.nodeId}</Text>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color={h.isLeader ? 'yellow' : 'gray'}>
                                            {h.isLeader ? 'Leader' : 'Follower'}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color={h.reachable ? 'green' : 'red'}>
                                            {h.reachable ? 'Yes' : 'No'}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>{h.nsmVersion || '—'}</Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color={matches ? 'green' : 'orange'}>
                                            {matches ? 'Up to date' : 'Mismatch'}
                                        </Badge>
                                    </Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            ) : (
                <Text c="dimmed">No node health reported yet.</Text>
            )}
        </Stack>
    );
};

export default ClusterStatusPage;
