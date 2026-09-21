import { Alert, Button, Card, Center, Divider, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DeploymentState, FullDirectoryMap, Project, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProjects } from '@/hooks/queries/useProjects';
import { usePatchProjectCache } from '@/hooks/mutations/projectMutations';
import { useDeployWeb, useTeardownProject, useCancelDeploy } from '@/hooks/mutations/deployMutations';
import { useProjectDeployAverage } from '@/hooks/queries/projectHooks';
import { useCluster } from '@/hooks/queries/useCluster';
import { ProjectHeader } from '@/components/ProjectHeader';
import { MdOutlineCancel, MdOutlineDelete, MdOutlineRocketLaunch } from 'react-icons/md';
import { DeployQueueBadge } from '@/components/DeployQueueBadge';
import { DeploymentInstanceList } from '@/components/deploy/DeploymentInstanceList';
import { DeploymentInstanceDetail } from '@/components/deploy/DeploymentInstanceDetail';
import { isInProgressState } from '@/utils/projectStatus';
import { deployQueueStatusFor, formatDeployEta } from '@/utils/deployQueue';

const LIST_REFRESH_INTERVAL_MS = 5000;

const ProjectDeployPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const { projects, refresh } = useProjects();
    const patchProject = usePatchProjectCache();
    const deployWeb = useDeployWeb();
    const teardownProject = useTeardownProject();
    const cancelDeploy = useCancelDeploy();
    const clusterCtx = useCluster();
    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [modal, setModal] = useState<'deploy' | 'teardown' | 'cancel' | null>(null);
    const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
    const [pendingHeader, setPendingHeader] = useState<ProjectInstanceHeader | null>(null);

    useEffect(() => {
        const foundProject = projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
    }, [projectId, projects]);

    const serverHeaders = useMemo(() => [...(project?.instances ?? [])].sort((a, b) => b.created - a.created), [project?.instances]);

    // Average deploy time for this project, computed server-side from the exact same rolling average
    // the leader uses to estimate the deploy queue (config sample size, successful deploys only), so
    // the two numbers always agree. Undefined until fetched or when the project has no history.
    // Re-fetched whenever a new successful deploy lands (deployedCount is part of the query key).
    const deployedCount = useMemo(() => serverHeaders.filter((h) => h.state === DeploymentState.DEPLOYED).length, [serverHeaders]);
    const { data: deployAverage } = useProjectDeployAverage(projectId, deployedCount);
    const avgDeployMs = deployAverage && deployAverage.sampleCount > 0 && deployAverage.deployMs != null ? deployAverage.deployMs : undefined;

    // Include a freshly-triggered deployment before the project list has caught up with it.
    const headers = useMemo(() => {
        if (pendingHeader && !serverHeaders.some((h) => h.id === pendingHeader.id)) return [pendingHeader, ...serverHeaders];
        return serverHeaders;
    }, [pendingHeader, serverHeaders]);

    // Drop the placeholder once the real instance shows up in the project list.
    useEffect(() => {
        if (pendingHeader && serverHeaders.some((h) => h.id === pendingHeader.id)) setPendingHeader(null);
    }, [serverHeaders, pendingHeader]);

    // Keep the selection valid, defaulting to the newest deployment.
    useEffect(() => {
        if (headers.length === 0) {
            setSelectedInstanceId(null);
            return;
        }
        setSelectedInstanceId((prev) => (prev && headers.some((h) => h.id === prev) ? prev : headers[0].id));
    }, [headers]);

    // Refresh the deployment list while anything is in flight so its state badges stay current.
    const anyInProgress = headers.some((h) => isInProgressState(h.state));
    useEffect(() => {
        if (!anyInProgress) return;
        const id = setInterval(() => void refresh(), LIST_REFRESH_INTERVAL_MS);
        return () => clearInterval(id);
    }, [anyInProgress]); // eslint-disable-line react-hooks/exhaustive-deps

    if (project === undefined) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }

    if (!project || !project.id) {
        return (
            <Center>
                <Stack>
                    <Title order={4}>Project &quot;{projectId}&quot; not found!</Title>
                </Stack>
            </Center>
        );
    }

    const handleDeploy = async () => {
        if (!project) return;
        notifications.show({ message: 'Queued for deployment...', color: 'blue' });
        const newLogId = await deployWeb.mutateAsync(project.id);
        if (!newLogId) {
            notifications.show({ message: 'Failed to get deployment log ID. Reload to see log', color: 'yellow' });
        } else {
            const now = Date.now();
            setPendingHeader({
                id: newLogId,
                projectId: project.id,
                workerNodeId: project.workerNodeId ?? '',
                state: DeploymentState.QUEUED,
                created: now,
                lastUpdated: now,
                active: false,
                directories: {} as FullDirectoryMap,
            });
            setSelectedInstanceId(newLogId);
        }
        patchProject(project.id, { dirtyConfig: false });
        void refresh();
    };

    const handleTeardown = async () => {
        if (!project) return;
        notifications.show({ message: 'Tearing down project...', color: 'blue' });
        await teardownProject.mutateAsync(project.id);
        patchProject(project.id, { state: DeploymentState.DESTROYING });
        notifications.show({ message: 'Teardown requested', color: 'green' });
    };

    const handleCancelDeploy = async () => {
        if (!project) return;
        notifications.show({ message: 'Cancelling deployment...', color: 'orange' });
        try {
            await cancelDeploy.mutateAsync(project.id);
            notifications.show({ message: 'Deployment cancellation requested', color: 'green' });
        } catch {
            notifications.show({ message: 'Failed to cancel deployment', color: 'red' });
        }
    };

    const queueStatus = deployQueueStatusFor(clusterCtx.status, project.id);
    const inQueue = queueStatus.state !== null;
    const canDeploy = project.hasDockerCompose && clusterCtx.hasLeader && !inQueue && project.state !== DeploymentState.DEPLOYING && project.state !== DeploymentState.DESTROYING;

    const selectedHeader = headers.find((h) => h.id === selectedInstanceId) ?? null;

    return (
        <Stack>
            <Modal opened={modal === 'deploy'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Deploy Project</Title>
                    <Text>
                        Are you sure you want to deploy the project?
                        <br />
                        This will trigger a deployment. Errors may occur.
                    </Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Do not deploy.
                        </Button>
                        <Button
                            variant="light"
                            color="green"
                            onClick={() => {
                                handleDeploy();
                                setModal(null);
                            }}
                        >
                            Yes. Deploy The Project.
                        </Button>
                    </Group>
                </Stack>
            </Modal>
            <Modal opened={modal === 'cancel'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Cancel Deployment</Title>
                    <Text>
                        Are you sure you want to cancel the in-progress deployment?
                        <br />
                        It will stop building immediately. Any previously deployed version keeps running.
                    </Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Keep Deploying.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                handleCancelDeploy();
                                setModal(null);
                            }}
                        >
                            Yes. Cancel The Deployment.
                        </Button>
                    </Group>
                </Stack>
            </Modal>
            <Modal opened={modal === 'teardown'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Teardown Project</Title>
                    <Text>
                        Are you sure you want to teardown the project?
                        <br />
                        This will take the project offline.
                    </Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Keep It Online.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                handleTeardown();
                                setModal(null);
                            }}
                        >
                            Yes. Teardown The Project.
                        </Button>
                    </Group>
                </Stack>
            </Modal>
            <ProjectHeader project={project} section="Deployment" />

            <Card withBorder>
                <Stack>
                    <Group>
                        <Button onClick={() => setModal('deploy')} variant="light" color="green" leftSection={<MdOutlineRocketLaunch />} disabled={!canDeploy}>
                            Deploy
                        </Button>
                        <DeployQueueBadge projectId={project.id} />
                        {formatDeployEta(avgDeployMs) && (
                            <Text size="sm" c="dimmed">
                                Typically deploys in {formatDeployEta(avgDeployMs)}
                            </Text>
                        )}
                        {inQueue && (
                            <Text size="sm" c="dimmed">
                                {queueStatus.state === 'active' ? 'Deploying now.' : `Waiting in queue (position ${queueStatus.position}).`}
                            </Text>
                        )}
                        {inQueue && (
                            <Button onClick={() => setModal('cancel')} variant="light" color="orange" leftSection={<MdOutlineCancel />}>
                                Cancel Deploy
                            </Button>
                        )}
                        <Button onClick={() => setModal('teardown')} variant="light" color="red" leftSection={<MdOutlineDelete />} disabled={!clusterCtx.hasLeader || project.state === DeploymentState.DESTROYING}>
                            Teardown
                        </Button>
                    </Group>
                </Stack>
            </Card>

            {!project.hasDockerCompose && (
                <Alert color="red" variant="filled" title="Undeployable Project">
                    This project does not have a Docker Compose file configured.
                </Alert>
            )}
            {!clusterCtx.hasLeader && (
                <Alert color="red" variant="filled" title="No Leader Node">
                    NSM has no reachable leader node.{' '}
                    <Link to="/nodes" style={{ textDecoration: 'underline' }}>
                        Check the nodes
                    </Link>{' '}
                    to enable deployments.
                </Alert>
            )}
            {!project.workerNodeId && (
                <Alert color="yellow" variant="light" title="No Node Assigned">
                    This project is not assigned to a node.{' '}
                    <Link to={`/p/${project.id}/config/project`} style={{ textDecoration: 'underline' }}>
                        Assign a node
                    </Link>{' '}
                    before deploying.
                </Alert>
            )}

            <Divider />
            <Title order={5}>Deployments</Title>
            {headers.length === 0 ? (
                <Text c="dimmed">No deployments yet. Trigger a deploy to get started.</Text>
            ) : (
                <Group align="flex-start" wrap="nowrap" gap="md">
                    <DeploymentInstanceList instances={headers} selectedId={selectedInstanceId} onSelect={setSelectedInstanceId} />
                    {selectedHeader && <DeploymentInstanceDetail key={selectedHeader.id} header={selectedHeader} />}
                </Group>
            )}
        </Stack>
    );
};

export default ProjectDeployPage;
