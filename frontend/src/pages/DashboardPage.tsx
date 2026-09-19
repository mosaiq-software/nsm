import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useUser } from '@/contexts/user-context';
import { useMe } from '@/contexts/me-context';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Capability, DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { deriveProjectState } from '@/utils/projectStatus';
import { summarizeDeployQueue, formatDeployEta } from '@/utils/deployQueue';
import { useAPI } from '@/utils/api';

const relativeTime = (ts: number): string => {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `${mins}m ago`;
};

type AttentionKind = 'failed' | 'drift' | 'unassigned' | 'nocompose';

interface AttentionItem {
    project: Project;
    kind: AttentionKind;
    message: string;
    action: string;
    to: string;
    color: string;
}

// Surface the things a project owner actually needs to act on, in priority order per project. These
// are the "debug" entry points: a failed deploy, config that drifted from what's live, or a project
// that structurally can't deploy yet (no node / no compose file).
const attentionItemsFor = (project: Project, state: DeploymentState | undefined): AttentionItem[] => {
    const items: AttentionItem[] = [];
    if (state === DeploymentState.FAILED) {
        items.push({ project, kind: 'failed', message: 'Last deploy failed', action: 'View deploy', to: `/p/${project.id}/deploy`, color: 'red' });
    }
    if (!project.hasDockerCompose) {
        items.push({ project, kind: 'nocompose', message: "No docker-compose detected \u2014 can't deploy", action: 'Configure', to: `/p/${project.id}/config/system`, color: 'orange' });
    }
    if (!project.workerNodeId) {
        items.push({ project, kind: 'unassigned', message: "No node assigned \u2014 can't deploy", action: 'Assign node', to: `/p/${project.id}/config/project`, color: 'orange' });
    }
    if (project.dirtyConfig) {
        items.push({ project, kind: 'drift', message: 'Config changed since last deploy', action: 'Deploy', to: `/p/${project.id}/deploy`, color: 'yellow' });
    }
    return items;
};

const DashboardPage = () => {
    const [queryParams, setQueryParams] = useSearchParams();
    const token = queryParams.get('token');
    const userCtx = useUser();
    const meCtx = useMe();
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

    const projects = projectCtx.projects;
    const stateOf = (project: Project): DeploymentState => projectCtx.statusById[project.id] ?? deriveProjectState(project);

    const attention = projects.flatMap((project) => attentionItemsFor(project, stateOf(project)));

    const queue = summarizeDeployQueue(clusterCtx.status);
    const canCancel = (projectId: string) => meCtx.canProject(projectId, Capability.DEPLOY);
    const queueHasActivity = queue.deploying.length + queue.queued.length + queue.hiddenDeploying + queue.hiddenQueued > 0;

    return (
        <Stack>
            <Title order={2}>Dashboard</Title>

            {attention.length > 0 && (
                <Card withBorder>
                    <Stack gap="sm">
                        <Title order={4}>Needs attention</Title>
                        <Stack gap="xs">
                            {attention.map((item) => (
                                <Alert key={`${item.project.id}-${item.kind}`} color={item.color} variant="light" p="xs">
                                    <Group justify="space-between" align="center" wrap="nowrap">
                                        <Group gap="xs" wrap="nowrap">
                                            <Text fw={600}>{item.project.id}</Text>
                                            <Text size="sm">{item.message}</Text>
                                        </Group>
                                        <Button component={Link} to={item.to} size="compact-sm" variant="light" color={item.color}>
                                            {item.action}
                                        </Button>
                                    </Group>
                                </Alert>
                            ))}
                        </Stack>
                    </Stack>
                </Card>
            )}

            <Card withBorder>
                <Stack gap="sm">
                    <Title order={4}>Deploy activity</Title>
                    {!queueHasActivity ? (
                        <Text c="dimmed" size="sm">
                            No deploys in progress. Deploys run one at a time.
                        </Text>
                    ) : (
                        <Stack gap="sm">
                            {queue.deploying.length + queue.queued.length > 0 && (
                                <Table>
                                    <Table.Thead>
                                        <Table.Tr>
                                            <Table.Th w={110}>Position</Table.Th>
                                            <Table.Th>Project</Table.Th>
                                            <Table.Th>Since</Table.Th>
                                            <Table.Th w={140}>Est. deploy time</Table.Th>
                                            <Table.Th w={110} />
                                        </Table.Tr>
                                    </Table.Thead>
                                    <Table.Tbody>
                                        {queue.deploying.map((entry) => (
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
                                                <Table.Td>{formatDeployEta(entry.estimatedDeployMs) ?? '—'}</Table.Td>
                                                <Table.Td>
                                                    {canCancel(entry.projectId) && (
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
                                                    )}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                        {queue.queued.map(({ entry, position }) => (
                                            <Table.Tr key={entry.instanceId} onClick={() => navigate(`/p/${entry.projectId}/deploy`)} style={{ cursor: 'pointer' }}>
                                                <Table.Td>
                                                    <Badge color="grape" variant="light">
                                                        #{position}
                                                    </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Text fw={600}>{entry.projectId}</Text>
                                                </Table.Td>
                                                <Table.Td>
                                                    <Stack gap={0}>
                                                        <Text size="sm">queued {relativeTime(entry.enqueuedAt)}</Text>
                                                        {formatDeployEta(entry.estimatedWaitMs) && (
                                                            <Text size="xs" c="dimmed">
                                                                starts in {formatDeployEta(entry.estimatedWaitMs)}
                                                            </Text>
                                                        )}
                                                    </Stack>
                                                </Table.Td>
                                                <Table.Td>{formatDeployEta(entry.estimatedDeployMs) ?? '—'}</Table.Td>
                                                <Table.Td>
                                                    {canCancel(entry.projectId) && (
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
                                                    )}
                                                </Table.Td>
                                            </Table.Tr>
                                        ))}
                                    </Table.Tbody>
                                </Table>
                            )}
                            {(queue.hiddenDeploying > 0 || queue.hiddenQueued > 0) && (
                                <Stack gap={2}>
                                    {queue.hiddenDeploying > 0 && (
                                        <Text c="dimmed" size="sm">
                                            {queue.hiddenDeploying} other {queue.hiddenDeploying === 1 ? 'deploy' : 'deploys'} in progress on projects you can't access.
                                        </Text>
                                    )}
                                    {queue.hiddenQueued > 0 && (
                                        <Text c="dimmed" size="sm">
                                            {queue.hiddenQueued} other {queue.hiddenQueued === 1 ? 'deploy' : 'deploys'} queued on projects you can't access.
                                        </Text>
                                    )}
                                </Stack>
                            )}
                        </Stack>
                    )}
                </Stack>
            </Card>
        </Stack>
    );
};

export default DashboardPage;
