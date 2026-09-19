import { Alert, Anchor, Badge, Group, Stack, Tabs, Text, Title, Tooltip } from '@mantine/core';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { MdArrowBack, MdOutlineStar } from 'react-icons/md';
import { useCluster } from '@/hooks/queries/useCluster';
import { useMe } from '@/hooks/queries/useMe';

const NodeDetailLayout = () => {
    const params = useParams();
    const nodeId = params.nodeId as string;
    const clusterCtx = useCluster();
    const meCtx = useMe();
    const navigate = useNavigate();
    const location = useLocation();

    const node = clusterCtx.nodes.find((n) => n.nodeId === nodeId);
    const health = clusterCtx.healthById[nodeId];

    const activeTab = location.pathname.endsWith('/config') ? 'config' : location.pathname.endsWith('/storage') ? 'storage' : 'overview';

    const handleTab = (value: string | null) => {
        if (!value) return;
        if (value === 'overview') navigate(`/nodes/${nodeId}`);
        else navigate(`/nodes/${nodeId}/${value}`);
    };

    return (
        <Stack>
            <Group gap="xs">
                <Anchor component={Link} to="/nodes" c="dimmed">
                    <Group gap={4}>
                        <MdArrowBack />
                        <Text>Nodes</Text>
                    </Group>
                </Anchor>
            </Group>
            <Group gap="sm">
                {node?.isLeader && (
                    <Tooltip label="Leader">
                        <span style={{ display: 'inline-flex', color: 'var(--mantine-color-yellow-6)' }}>
                            <MdOutlineStar />
                        </span>
                    </Tooltip>
                )}
                <Title order={2}>{nodeId}</Title>
                {node && (
                    <Badge variant="light" color={node.isLeader ? 'yellow' : 'gray'}>
                        {node.isLeader ? 'Leader' : 'Follower'}
                    </Badge>
                )}
                {health && (
                    <Badge variant="light" color={health.reachable ? 'green' : 'red'}>
                        {health.reachable ? 'Reachable' : 'Unreachable'}
                    </Badge>
                )}
            </Group>

            <Tabs value={activeTab} onChange={handleTab}>
                <Tabs.List>
                    <Tabs.Tab value="overview">Overview</Tabs.Tab>
                    {meCtx.isAdmin && <Tabs.Tab value="config">Config</Tabs.Tab>}
                    <Tabs.Tab value="storage">Storage</Tabs.Tab>
                </Tabs.List>
            </Tabs>

            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Metrics unavailable">
                    Node metrics are served by the leader. No leader is currently reachable.
                </Alert>
            )}

            <Outlet />
        </Stack>
    );
};

export default NodeDetailLayout;
