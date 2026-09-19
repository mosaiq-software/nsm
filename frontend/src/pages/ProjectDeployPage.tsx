import { ActionIcon, Alert, Anchor, Box, Button, Card, Center, CopyButton, Divider, Group, Loader, Modal, PasswordInput, Stack, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability, DeploymentState, FullDirectoryMap, Project, ProjectInstanceHeader } from '@mosaiq/nsm-common/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useMe } from '@/contexts/me-context';
import { ProjectHeader } from '@/components/ProjectHeader';
import { CdWizard } from '@/components/cicd/CdWizard';
import { MdOutlineCancel, MdOutlineCheckBox, MdOutlineDelete, MdOutlineInsertLink, MdOutlineKey, MdOutlineRocketLaunch, MdOutlineSync } from 'react-icons/md';
import { DeployQueueBadge } from '@/components/DeployQueueBadge';
import { DeploymentInstanceList } from '@/components/deploy/DeploymentInstanceList';
import { DeploymentInstanceDetail } from '@/components/deploy/DeploymentInstanceDetail';
import { isInProgressState } from '@/components/deploy/DeploymentStateBadge';
import { deployQueueStatusFor, formatDeployEta } from '@/utils/deployQueue';
import { useAPI } from '@/utils/api';

const LIST_REFRESH_INTERVAL_MS = 5000;

const ProjectDeployPage = () => {
    const api = useAPI();
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const meCtx = useMe();
    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [modal, setModal] = useState<'reset-key' | 'deploy' | 'teardown' | 'cancel' | 'cd-wizard' | 'cd-remove' | null>(null);
    const [removingCd, setRemovingCd] = useState(false);
    const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
    const [pendingHeader, setPendingHeader] = useState<ProjectInstanceHeader | null>(null);

    useEffect(() => {
        const foundProject = projectCtx.projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
    }, [projectId, projectCtx.projects]);

    const serverHeaders = useMemo(() => [...(project?.instances ?? [])].sort((a, b) => b.created - a.created), [project?.instances]);

    // Rolling average of recent successful deploys, so the page can show roughly how long a deploy of
    // this app takes. Mirrors the leader's estimate (newest first, capped at 10 samples).
    const avgDeployMs = useMemo(() => {
        const durations = serverHeaders
            .filter((h) => h.state === DeploymentState.DEPLOYED && typeof h.deployDurationMs === 'number')
            .slice(0, 10)
            .map((h) => h.deployDurationMs as number);
        if (!durations.length) return undefined;
        return durations.reduce((a, b) => a + b, 0) / durations.length;
    }, [serverHeaders]);

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
        const id = setInterval(() => void projectCtx.refresh(), LIST_REFRESH_INTERVAL_MS);
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
        const newLogId = await api.get(API_ROUTES.GET_DEPLOY_WEB, { projectId: project.id, key: project.deploymentKey ?? '' });
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
        projectCtx.update(project.id, { dirtyConfig: false }, true);
        void projectCtx.refresh();
    };

    const handleResetDeployKey = async () => {
        if (!project) return;
        notifications.show({ message: 'Resetting deployment key...', color: 'blue' });
        const newKey = await api.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, { projectId: project.id }, {});
        if (!newKey) {
            notifications.show({ message: 'Failed to reset deployment key!', color: 'red' });
            return;
        }
        notifications.show({ message: 'Deployment key reset successful!', color: 'green' });
        projectCtx.update(project.id, { deploymentKey: newKey }, true);
    };

    const handleTeardown = async () => {
        if (!project) return;
        notifications.show({ message: 'Tearing down project...', color: 'blue' });
        await api.post(API_ROUTES.POST_TEARDOWN_PROJECT, { projectId: project.id }, {});
        projectCtx.update(project.id, { state: DeploymentState.DESTROYING }, true);
        notifications.show({ message: 'Teardown requested', color: 'green' });
    };

    const handleCancelDeploy = async () => {
        if (!project) return;
        notifications.show({ message: 'Cancelling deployment...', color: 'orange' });
        try {
            await api.post(API_ROUTES.POST_CANCEL_DEPLOY, { projectId: project.id }, {});
            notifications.show({ message: 'Deployment cancellation requested', color: 'green' });
        } catch {
            notifications.show({ message: 'Failed to cancel deployment', color: 'red' });
        }
    };

    const handleRemoveCd = async () => {
        if (!project) return;
        setRemovingCd(true);
        notifications.show({ message: 'Removing CI/CD...', color: 'orange' });
        try {
            const updated = await api.post(API_ROUTES.POST_CICD_REMOVE, { projectId: project.id }, {});
            if (!updated) {
                notifications.show({ message: 'Failed to remove CI/CD', color: 'red' });
                return;
            }
            projectCtx.update(project.id, { cicd: undefined }, true);
            notifications.show({ message: 'CI/CD removed', color: 'green' });
        } catch {
            notifications.show({ message: 'Failed to remove CI/CD', color: 'red' });
        } finally {
            setRemovingCd(false);
        }
    };

    // The team the project belongs to (used to hide the CD card when the App isn't installed).
    const projectTeam = meCtx.teams.find((t) => t.projects.some((p) => p.id === project.id));
    const canConfigure = meCtx.canProject(project.id, Capability.CONFIGURE);
    const cdCardVisible = canConfigure && !!projectTeam?.installed;
    const cd = project.cicd;

    const queueStatus = deployQueueStatusFor(clusterCtx.status, project.id);
    const inQueue = queueStatus.state !== null;
    const canDeploy = project.hasDockerCompose && clusterCtx.hasLeader && !inQueue && project.state !== DeploymentState.DEPLOYING && project.state !== DeploymentState.DESTROYING;

    const deployUrl = `${window.location.origin}/deploy/${project.id}/${project.deploymentKey}`;

    const selectedHeader = headers.find((h) => h.id === selectedInstanceId) ?? null;

    return (
        <Stack>
            <Modal opened={modal === 'reset-key'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Reset Deployment Key</Title>
                    <Text>Resetting the deployment key will regenerate it. All CI/CD pipelines using the old key will fail.</Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Keep The Key.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                handleResetDeployKey();
                                setModal(null);
                            }}
                        >
                            Yes. Reset The Key.
                        </Button>
                    </Group>
                </Stack>
            </Modal>
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
            <Modal opened={modal === 'cd-wizard'} onClose={() => setModal(null)} title="Set up Continuous Deployment" size="lg">
                <CdWizard
                    project={project}
                    onCancel={() => setModal(null)}
                    onComplete={(updated) => {
                        projectCtx.update(project.id, { cicd: updated.cicd, allowCICD: updated.allowCICD }, true);
                        setModal(null);
                    }}
                />
            </Modal>
            <Modal opened={modal === 'cd-remove'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Remove Continuous Deployment</Title>
                    <Text>
                        This deletes the managed workflow file{cd?.viaPr ? ' and its pull-request branch' : ''} and the deploy-key repository secret. To change the configuration, remove it and run the wizard again.
                    </Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Keep CI/CD.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                handleRemoveCd();
                                setModal(null);
                            }}
                        >
                            Yes. Remove CI/CD.
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
                    <Group align="flex-end" wrap="nowrap">
                        <PasswordInput label="Deployment Key" value={project.deploymentKey} readOnly w={'32ch'} />
                        <CopyButton value={project.deploymentKey ?? ''}>
                            {({ copied, copy }) => (
                                <Tooltip label={'Copy key'} withArrow>
                                    <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy} size="input-sm">
                                        {copied ? <MdOutlineCheckBox /> : <MdOutlineKey />}
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </CopyButton>
                        <CopyButton value={deployUrl}>
                            {({ copied, copy }) => (
                                <Tooltip label={'Copy Deploy URL'} withArrow>
                                    <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy} size="input-sm">
                                        {copied ? <MdOutlineCheckBox /> : <MdOutlineInsertLink />}
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </CopyButton>
                        <Box flex={1} h="md">
                            <Divider />
                        </Box>
                        <Button color="red" variant="light" onClick={() => setModal('reset-key')}>
                            Reset Key
                        </Button>
                    </Group>
                </Stack>
            </Card>

            {cdCardVisible && (
                <Card withBorder>
                    <Stack>
                        <Group justify="space-between">
                            <Group gap="xs">
                                <MdOutlineSync />
                                <Title order={5}>Continuous Deployment</Title>
                            </Group>
                            {cd?.managed ? (
                                <Button variant="light" color="red" leftSection={<MdOutlineDelete />} loading={removingCd} onClick={() => setModal('cd-remove')}>
                                    Remove CD
                                </Button>
                            ) : (
                                <Button variant="light" leftSection={<MdOutlineRocketLaunch />} onClick={() => setModal('cd-wizard')}>
                                    Set up CI/CD
                                </Button>
                            )}
                        </Group>
                        {cd?.managed ? (
                            <Stack gap={4}>
                                <Text size="sm">
                                    Triggers: <b>{cd.triggers.join(', ')}</b>
                                </Text>
                                <Text size="sm">
                                    Deploy branch: <b>{cd.branch}</b>
                                </Text>
                                <Text size="sm">
                                    Workflow file: <b>{cd.workflowPath}</b>
                                </Text>
                                {cd.prUrl && (
                                    <Text size="sm">
                                        Pull request:{' '}
                                        <Anchor href={cd.prUrl} target="_blank" rel="noreferrer">
                                            {cd.prUrl}
                                        </Anchor>
                                    </Text>
                                )}
                            </Stack>
                        ) : (
                            <Text size="sm" c="dimmed">
                                Let NSM provision a managed GitHub Actions workflow that deploys this project automatically. The deploy key is stored as an encrypted repository secret.
                            </Text>
                        )}
                    </Stack>
                </Card>
            )}

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
                    <Link to={`/p/${project.id}/config`} style={{ textDecoration: 'underline' }}>
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
