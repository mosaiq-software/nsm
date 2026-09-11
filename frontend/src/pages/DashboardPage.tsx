import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useUser } from '@/contexts/user-context';
import { Badge, Button, Card, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { DeploymentState } from '@mosaiq/nsm-common/types';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

const stateColor = (state?: DeploymentState) => {
    switch (state) {
        case DeploymentState.HEALTHY:
        case DeploymentState.DEPLOYED:
            return 'green';
        case DeploymentState.DEPLOYING:
            return 'blue';
        case DeploymentState.FAILED:
            return 'red';
        case DeploymentState.DESTROYING:
            return 'orange';
        default:
            return 'gray';
    }
};

const DashboardPage = () => {
    const [queryParams, setQueryParams] = useSearchParams();
    const token = queryParams.get('token');
    const userCtx = useUser();
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const navigate = useNavigate();

    useEffect(() => {
        if (token) {
            userCtx.startSession(token);
            setQueryParams({});
        }
    }, [token]);

    const reachable = clusterCtx.status?.health.filter((h) => h.reachable).length ?? 0;

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
                                    <Badge color={stateColor(project.state)}>{project.state ?? 'unknown'}</Badge>
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
