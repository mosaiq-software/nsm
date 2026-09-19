import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Center, Code, Collapse, CopyButton, Group, Loader, Paper, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useCluster } from '@/contexts/cluster-context';
import { useAPI } from '@/utils/api';
import { MdExpandLess, MdExpandMore, MdOutlineStar } from 'react-icons/md';

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

const AddNodePanel = () => {
    const api = useAPI();
    const [command, setCommand] = useState<string | null>(null);
    const [deployPublicKey, setDeployPublicKey] = useState<string | null>(null);
    const [opened, { toggle }] = useDisclosure(false);

    useEffect(() => {
        let cancelled = false;
        if (!api.token) return;
        void (async () => {
            const info = await api.get(API_ROUTES.GET_JOIN_INFO, {});
            if (cancelled || !info) return;
            setCommand(info.command);
            setDeployPublicKey(info.deployPublicKey);
        })();
        return () => {
            cancelled = true;
        };
    }, [api.token]);

    if (!command) return null;

    return (
        <Paper withBorder p="md" radius="md">
            <Stack gap="xs">
                <Group
                    justify="space-between"
                    align="center"
                    wrap="nowrap"
                    onClick={toggle}
                    style={{ cursor: 'pointer' }}
                >
                    <Title order={4}>Add a node</Title>
                    <ActionIcon variant="subtle" aria-label={opened ? 'Collapse' : 'Expand'}>
                        {opened ? <MdExpandLess size={20} /> : <MdExpandMore size={20} />}
                    </ActionIcon>
                </Group>
                <Collapse in={opened}>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">Run this on a fresh Ubuntu machine to install NSM and join it to this cluster. The cluster secret and this leader&apos;s address are already baked in.</Text>
                        <Group align="stretch" wrap="nowrap">
                            <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</Code>
                            <CopyButton value={command}>
                                {({ copied, copy }) => (
                                    <Button variant="light" color={copied ? 'green' : 'blue'} onClick={copy}>
                                        {copied ? 'Copied' : 'Copy'}
                                    </Button>
                                )}
                            </CopyButton>
                        </Group>
                        {deployPublicKey && (
                            <Stack gap={4}>
                                <Text size="sm" fw={600}>Deploy public key</Text>
                                <Text c="dimmed" size="xs">Register this once on GitHub (as a repo/org deploy key or a machine user) so nodes can clone your app repositories.</Text>
                                <Group align="stretch" wrap="nowrap">
                                    <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{deployPublicKey}</Code>
                                    <CopyButton value={deployPublicKey}>
                                        {({ copied, copy }) => (
                                            <Button variant="light" color={copied ? 'green' : 'blue'} onClick={copy}>
                                                {copied ? 'Copied' : 'Copy'}
                                            </Button>
                                        )}
                                    </CopyButton>
                                </Group>
                            </Stack>
                        )}
                    </Stack>
                </Collapse>
            </Stack>
        </Paper>
    );
};

const NodesPage = () => {
    const clusterCtx = useCluster();
    const status = clusterCtx.status;
    const navigate = useNavigate();

    const reachableCount = status?.health.filter((h) => h.reachable).length ?? 0;
    const totalCount = status?.nodes.length ?? clusterCtx.nodes.length;

    return (
        <Stack>
            <Title order={2}>Nodes</Title>
            <Text c="dimmed">Nodes self-register with the leader. This registry is read-only; membership is declared in each node&apos;s configuration.</Text>
            <AddNodePanel />
            {!clusterCtx.hasLeader && (
                <Alert color="red" variant="light" title="No Leader">
                    No leader node is currently reachable. Cluster status and deployments are unavailable until a leader is up.
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
            {clusterCtx.nodes.length === 0 ? (
                <Center py="xl">
                    {clusterCtx.status === null ? <Loader /> : <Text c="dimmed">No nodes registered yet.</Text>}
                </Center>
            ) : (
                <Table highlightOnHover>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Node ID</Table.Th>
                            <Table.Th>Address</Table.Th>
                            <Table.Th>API Port</Table.Th>
                            <Table.Th>Role</Table.Th>
                            <Table.Th>Health</Table.Th>
                            <Table.Th>NSM Version</Table.Th>
                            <Table.Th>Version Match</Table.Th>
                            <Table.Th>Last Seen</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {clusterCtx.nodes.map((node) => {
                            const health = clusterCtx.healthById[node.nodeId];
                            const reachable = health?.reachable ?? false;
                            const matches = status?.desiredNsmVersion ? health?.nsmVersion === status.desiredNsmVersion : true;
                            return (
                                <Table.Tr key={node.nodeId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/nodes/${node.nodeId}`)}>
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
                                    <Table.Td>
                                        <Badge variant="light" color={matches ? 'green' : 'orange'}>
                                            {matches ? 'Up to date' : 'Mismatch'}
                                        </Badge>
                                    </Table.Td>
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
