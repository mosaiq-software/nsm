import { Alert, Badge, Center, Group, Loader, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useCluster } from '@/contexts/cluster-context';
import { MdOutlineStar } from 'react-icons/md';

const relativeTime = (ts: number) => {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 0) return 'just now';
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(ts).toLocaleString();
};

const NodesPage = () => {
    const clusterCtx = useCluster();

    return (
        <Stack>
            <Title order={2}>Nodes</Title>
            <Text c="dimmed">Nodes self-register with the leader. This registry is read-only; membership is declared in each node&apos;s configuration.</Text>
            {!clusterCtx.hasLeader && (
                <Alert color="red" variant="light" title="No Leader">
                    No leader node is currently reachable. Cluster status and deployments are unavailable until a leader is up.
                </Alert>
            )}
            {clusterCtx.nodes.length === 0 ? (
                <Center py="xl">
                    {clusterCtx.status === null ? <Loader /> : <Text c="dimmed">No nodes registered yet.</Text>}
                </Center>
            ) : (
                <Table>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Node ID</Table.Th>
                            <Table.Th>Address</Table.Th>
                            <Table.Th>API Port</Table.Th>
                            <Table.Th>Role</Table.Th>
                            <Table.Th>Health</Table.Th>
                            <Table.Th>NSM Version</Table.Th>
                            <Table.Th>Last Seen</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {clusterCtx.nodes.map((node) => {
                            const health = clusterCtx.healthById[node.nodeId];
                            const reachable = health?.reachable ?? false;
                            return (
                                <Table.Tr key={node.nodeId}>
                                    <Table.Td>
                                        <Group gap={6}>
                                            {node.isLeader && (
                                                <Tooltip label="Leader">
                                                    <span style={{ display: 'inline-flex', color: 'var(--mantine-color-yellow-6)' }}>
                                                        <MdOutlineStar />
                                                    </span>
                                                </Tooltip>
                                            )}
                                            <Text fw={600}>{node.nodeId}</Text>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>{node.address}</Table.Td>
                                    <Table.Td>{node.apiPort}</Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color={node.isLeader ? 'yellow' : 'gray'}>
                                            {node.isLeader ? 'Leader' : 'Follower'}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge variant="light" color={reachable ? 'green' : 'red'}>
                                            {reachable ? 'Reachable' : 'Unreachable'}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>{health?.nsmVersion ?? '—'}</Table.Td>
                                    <Table.Td>{relativeTime(node.lastSeen)}</Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
};

export default NodesPage;
