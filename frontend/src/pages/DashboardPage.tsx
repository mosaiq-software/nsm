import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useUser } from '@/contexts/user-context';
import { Badge, Button, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DeployQueueBadge } from '@/components/DeployQueueBadge';
import { useAPI } from '@/utils/api';

const stateColor = (state?: DeploymentState) => {
    switch (state) {
        case DeploymentState.HEALTHY:
        case DeploymentState.DEPLOYED:
            return 'green';
        case DeploymentState.DEPLOYING:
            return 'blue';
        case DeploymentState.QUEUED:
            return 'grape';
        case DeploymentState.FAILED:
            return 'red';
        case DeploymentState.CANCELLED:
            return 'gray';
        case DeploymentState.DESTROYING:
            return 'orange';
        default:
            return 'gray';
    }
};

const relativeTime = (ts: number): string => {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `${mins}m ago`;
};

const DashboardPage = () => {
    const [queryParams, setQueryParams] = useSearchParams();
    const token = queryParams.get('token');
    const userCtx = useUser();
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const navigate = useNavigate();
    const api = useAPI();

    useEffect(() => {
        if (token) {
            userCtx.startSession(token);
            setQueryParams({});
        }
    }, [token]);

    const handleCancelDeploy = async (projectId: string) => {
        notifications.show({ message: `Cancelling deployment of ${projectId}...`, color: 'orange' });
        try {
            await api.post(API_ROUTES.POST_CANCEL_DEPLOY, { projectId }, {});
            notifications.show({ message: `Cancelled deployment of ${projectId}`, color: 'green' });
        } catch {
            notifications.show({ message: `Failed to cancel deployment of ${projectId}`, color: 'red' });
        }
    };

    const reachable = clusterCtx.status?.health.filter((h) => h.reachable).length ?? 0;
    const deployQueue = clusterCtx.status?.deployQueue;
    const deploying = deployQueue?.deploying ?? [];
    // Include the leader planning slot only if it isn't already reflected in `deploying`.
    const active = deployQueue?.active && !deploying.some((d) => d.projectId === deployQueue.active!.projectId) ? deployQueue.active : null;
    const deployingRows = [...(active ? [active] : []), ...deploying];
    const queued = deployQueue?.queued ?? [];
    const queueCount = deployingRows.length + queued.length;

    return (
        <Stack>
            <Group>
                <Title order={2}>NSM Dashboard</Title>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
                <Card withBorder>
                    <Stack gap={4}>
                        <Text c="dimmed" size="sm">
                            Projects
                        </Text>
                        <Title order={3}>{projectCtx.projects.length}</Title>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap={4}>
                        <Text c="dimmed" size="sm">
                            Nodes
                        </Text>
                        <Title order={3}>{clusterCtx.nodes.length}</Title>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap={4}>
                        <Text c="dimmed" size="sm">
                            Reachable Nodes
                        </Text>
                        <Title order={3}>{reachable}</Title>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap={4}>
                        <Text c="dimmed" size="sm">
                            Leader
                        </Text>
                        <Title order={3}>{clusterCtx.leader?.nodeId ?? 'None'}</Title>
                    </Stack>
                </Card>
            </SimpleGrid>
            <Card withBorder>
                <Stack gap="sm">
                    <Group justify="space-between" align="center">
                        <Title order={4}>Deploy Queue</Title>
                        <Badge color={queueCount > 0 ? 'grape' : 'gray'} variant="light">
                            {queueCount} {queueCount === 1 ? 'deploy' : 'deploys'}
                        </Badge>
                    </Group>
                    {queueCount === 0 ? (
                        <Text c="dimmed" size="sm">
                            No deploys in progress. Deploys run one at a time.
                        </Text>
                    ) : (
                        <Table>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th w={110}>Position</Table.Th>
                                    <Table.Th>Project</Table.Th>
                                    <Table.Th>Since</Table.Th>
                                    <Table.Th w={110} />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {deployingRows.map((entry) => (
                                    <Table.Tr key={entry.instanceId} onClick={() => navigate(`/p/${entry.projectId}/deploy`)} style={{ cursor: 'pointer' }}>
                                        <Table.Td>
                                            <Group gap={6} wrap="nowrap">
                                                <Loader size="xs" />
                                                <Badge color="blue" variant="light">
                                                    Deploying
                                                </Badge>
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text fw={600}>{entry.projectId}</Text>
                                        </Table.Td>
                                        <Table.Td>{relativeTime(entry.startedAt)}</Table.Td>
                                        <Table.Td>
                                            <Button
                                                size="compact-xs"
                                                color="red"
                                                variant="light"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCancelDeploy(entry.projectId);
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                                {queued.map((entry, idx) => (
                                    <Table.Tr key={entry.instanceId} onClick={() => navigate(`/p/${entry.projectId}/deploy`)} style={{ cursor: 'pointer' }}>
                                        <Table.Td>
                                            <Badge color="grape" variant="light">
                                                #{idx + 1}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text fw={600}>{entry.projectId}</Text>
                                        </Table.Td>
                                        <Table.Td>queued {relativeTime(entry.enqueuedAt)}</Table.Td>
                                        <Table.Td>
                                            <Button
                                                size="compact-xs"
                                                color="red"
                                                variant="light"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleCancelDeploy(entry.projectId);
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}
                </Stack>
            </Card>
            <Group justify="space-between" align="center">
                <Title order={4}>Projects</Title>
                <Button component={Link} to="/nodes" variant="subtle" size="compact-sm">
                    View Nodes
                </Button>
            </Group>
            {projectCtx.projects.length === 0 ? (
                <Text c="dimmed">No projects yet. Create one from the sidebar.</Text>
            ) : (
                <Table highlightOnHover>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Project</Table.Th>
                            <Table.Th>Repository</Table.Th>
                            <Table.Th>Node</Table.Th>
                            <Table.Th>State</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {projectCtx.projects.map((project) => (
                            <Table.Tr key={project.id} onClick={() => navigate(`/p/${project.id}`)} style={{ cursor: 'pointer' }}>
                                <Table.Td>
                                    <Text fw={600}>{project.id}</Text>
                                </Table.Td>
                                <Table.Td>
                                    {project.repoOwner}/{project.repoName}
                                </Table.Td>
                                <Table.Td>{project.workerNodeId ?? 'Unassigned'}</Table.Td>
                                <Table.Td>
                                    <Group gap="xs">
                                        <Badge color={stateColor(project.state)}>{project.state ?? 'unknown'}</Badge>
                                        <DeployQueueBadge projectId={project.id} />
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
};

export default DashboardPage;
