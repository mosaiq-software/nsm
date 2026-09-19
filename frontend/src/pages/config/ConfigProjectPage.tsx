import { Alert, Button, Code, Divider, Group, List, NumberInput, Select, Stack, Switch, Text, TextInput, Title, Tooltip, Modal } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Capability } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MdOutlineLan, MdOutlineLaunch } from 'react-icons/md';
import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useMe } from '@/contexts/me-context';
import { useAPI } from '@/utils/api';
import { CdWizardLauncher } from '@/components/cicd/CdWizardLauncher';
import { useProjectConfig } from './projectConfigContext';

const ConfigProjectPage = () => {
    const { project, updateProject, portReservations } = useProjectConfig();
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const meCtx = useMe();
    const api = useAPI();
    const navigate = useNavigate();
    const [deleteModal, setDeleteModal] = useState(false);

    const projectTeam = meCtx.teams.find((t) => t.projects.some((p) => p.id === project.id));
    const cdVisible = !!projectTeam?.installed;

    const handleAssignNode = async (nodeId: string | undefined) => {
        updateProject({ workerNodeId: nodeId });
        if (!nodeId) return;
        await api.post(API_ROUTES.POST_SET_PROJECT_ASSIGNMENT, { projectId: project.id }, { nodeId });
        projectCtx.update(project.id, { workerNodeId: nodeId }, true);
        notifications.show({ message: `Assigned ${project.id} to ${nodeId}`, color: 'green' });
    };

    const handleDeleteProject = async () => {
        try {
            await projectCtx.delete(project.id);
            notifications.show({ title: 'Success', message: 'Project deleted successfully', color: 'green' });
            navigate('/');
        } catch (error) {
            notifications.show({ title: 'Error', message: 'Failed to delete project', color: 'red' });
        }
    };

    const assignedReservations = portReservations.filter((r) => r.nodeId === project.workerNodeId);
    const elsewhere = portReservations.filter((r) => r.nodeId !== project.workerNodeId);

    return (
        <>
            <Modal opened={deleteModal} onClose={() => setDeleteModal(false)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Delete {project.id}</Title>
                    <Text>Are you sure you want to delete this project? This action cannot be undone.</Text>
                    <Group>
                        <Button variant="outline" onClick={() => setDeleteModal(false)}>
                            Cancel
                        </Button>
                        <Button variant="filled" color="red" onClick={handleDeleteProject}>
                            Delete Project
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Stack>
                <Title order={4}>General</Title>
                <Group align="flex-start" justify="space-evenly">
                    <Stack gap={2} align="center">
                        <Group>
                            <TextInput w="30%" required description="User or Organization" label="Repository Owner" placeholder="mosaiq-software" value={project.repoOwner} onChange={(e) => updateProject({ repoOwner: e.currentTarget.value })} />
                            <TextInput w="30%" required description="As seen in the URL" label="Repository Name" placeholder="server-manager" value={project.repoName} onChange={(e) => updateProject({ repoName: e.currentTarget.value })} />
                            <TextInput w="30%" description="Optional branch to deploy from" label="Repository Branch" placeholder="main" value={project.repoBranch} onChange={(e) => updateProject({ repoBranch: e.currentTarget.value })} />
                        </Group>
                        <Text
                            fz=".75rem"
                            c="dimmed"
                            component="a"
                            href={`https://github.com/${project.repoOwner}/${project.repoName}.git`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        >
                            {`https://github.com/${project.repoOwner}/${project.repoName}.git`} <MdOutlineLaunch />
                        </Text>
                    </Stack>
                    <Select
                        required
                        label="Node"
                        description="Which node hosts this project's deployments? A star marks nodes with ports reserved for this project."
                        data={clusterCtx.nodes.map((node) => {
                            const starred = portReservations.some((r) => r.nodeId === node.nodeId);
                            return { value: node.nodeId, label: `${starred ? '\u2605 ' : ''}${node.nodeId} (@${node.address})${node.isLeader ? ' • leader' : ''}` };
                        })}
                        onChange={(value) => handleAssignNode(value || undefined)}
                        value={project.workerNodeId ?? null}
                        placeholder="Select a node"
                        nothingFoundMessage="No nodes registered"
                    />
                    {assignedReservations.length > 0 ? (
                        <Alert color="blue" variant="light" icon={<MdOutlineLan />} title="Reserved ports injected as env vars">
                            <Text size="sm">When deployed on {project.workerNodeId}, these forwarded ports are available as environment variables. Publish them in your compose (e.g. <Code>{'${ENV}:25565/udp'}</Code>).</Text>
                            <List size="sm" mt={4}>
                                {assignedReservations.map((r) => (
                                    <List.Item key={r.id}>
                                        <Code>{r.envVarName}</Code> = {r.port} ({r.protocol.toUpperCase()}){r.label ? ` — ${r.label}` : ''}
                                    </List.Item>
                                ))}
                            </List>
                        </Alert>
                    ) : elsewhere.length > 0 ? (
                        <Alert color="yellow" variant="light" icon={<MdOutlineLan />} title="Reserved ports on other nodes">
                            <Text size="sm">This project has reserved ports on: {Array.from(new Set(elsewhere.map((r) => r.nodeId))).join(', ')} (starred above). Assign it to one of those nodes to use those forwarded ports as environment variables.</Text>
                        </Alert>
                    ) : null}
                    <NumberInput
                        value={project.timeout}
                        label="Deployment Timeout (ms)"
                        placeholder={(1000 * 60 * 5).toString()}
                        min={0}
                        max={1000 * 60 * 60}
                        description="The max time it can take to deploy"
                        onChange={(e) => {
                            if (e === '') {
                                updateProject({ timeout: undefined });
                                return;
                            }
                            const value = Number(e);
                            if (!isNaN(value)) {
                                updateProject({ timeout: value });
                            }
                        }}
                    />
                    <Stack gap={2} align="center">
                        <Text fz="var(--input-label-size, var(--mantine-font-size-sm))">Allow CI/CD</Text>
                        <Switch checked={project.allowCICD} onChange={(e) => updateProject({ allowCICD: e.currentTarget.checked })} />
                    </Stack>
                </Group>

                {cdVisible && (
                    <>
                        <Divider my="sm" />
                        <CdWizardLauncher project={project} />
                    </>
                )}

                {meCtx.canProject(project.id, Capability.DELETE) && (
                    <>
                        <Divider my="sm" />
                        <Alert color="red" variant="light" title="Danger Zone">
                            <Stack>
                                <Group>
                                    <Tooltip label="Delete Project">
                                        <Button color="red" variant="outline" onClick={() => setDeleteModal(true)}>
                                            Delete Project
                                        </Button>
                                    </Tooltip>
                                </Group>
                            </Stack>
                        </Alert>
                    </>
                )}
            </Stack>
        </>
    );
};

export default ConfigProjectPage;
