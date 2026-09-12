import { ActionIcon, ActionIconGroup, Alert, Button, Center, Code, Combobox, Divider, Fieldset, Grid, Group, HoverCard, List, Loader, Modal, NumberInput, ScrollArea, Select, Space, Stack, Switch, Text, Textarea, TextInput, Title, Tooltip, useCombobox } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DockerStatus, DynamicEnvVariable, NginxConfigLocationType, Project, ProjectService, Secret, UpperDynamicEnvVariableType } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { useAPI } from '@/utils/api';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ProjectHeader } from '@/components/ProjectHeader';
import { assembleDotenv, extractVariables, parseDynamicVariablePath } from '@mosaiq/nsm-common/secretUtil';
import { NginxEditor } from '@/components/NginxEditor';
import { MdOutlineCode, MdOutlineDns, MdOutlineDownload, MdOutlineInfo, MdOutlineLan, MdOutlineLaunch, MdOutlineLink, MdOutlineLinkOff, MdOutlineRefresh, MdOutlineUmbrella, MdOutlineUpload, MdOutlineWeb } from 'react-icons/md';
import { useWindowEvent } from '@mantine/hooks';

const ProjectConfigPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const navigate = useNavigate();
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const api = useAPI();
    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [secrets, setSecrets] = useState<Secret[]>([]);
    const [dynamicEnvVariables, setDynamicEnvVariables] = useState<DynamicEnvVariable[]>([]);
    const [syncing, setSyncing] = useState(false);
    const [modal, setModal] = useState<'delete-project' | 'import-dotenv' | null>(null);
    const [importingDotenv, setImportingDotenv] = useState('');

    useWindowEvent('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            event.stopPropagation();
            if (!same()) {
                saveChanges();
            }
        }
    });

    useEffect(() => {
        const foundProject = projectCtx.projects.find((proj) => proj.id === projectId);
        if (foundProject) {
            const vars = extractVariables(foundProject);
            setProject({ ...foundProject });
            setDynamicEnvVariables(vars);
            setSecrets(foundProject.secrets ?? []);
        }
    }, [projectId, projectCtx.projects]);

    const updateProject = (updatedFields: Partial<Project>) => {
        if (project) {
            const vars = extractVariables({ ...project, ...updatedFields });
            setProject({ ...project, ...updatedFields });
            setDynamicEnvVariables(vars);
        }
    };

    const handleAssignNode = async (nodeId: string | undefined) => {
        if (!project) return;
        updateProject({ workerNodeId: nodeId });
        if (!nodeId) return;
        const res = await api.post(API_ROUTES.POST_SET_PROJECT_ASSIGNMENT, { projectId: project.id }, { nodeId });
        if (res === undefined) {
            // Reflect the assignment client-side even when the endpoint returns no body (204-style).
        }
        projectCtx.update(project.id, { workerNodeId: nodeId }, true);
        notifications.show({ message: `Assigned ${project.id} to ${nodeId}`, color: 'green' });
    };

    const updateSecret = (secret: Secret) => {
        const existing = secrets.find((s) => s.secretName === secret.secretName);
        if (!existing) {
            return;
        }
        setSecrets((prev) => prev.map((s) => (s.secretName === secret.secretName ? secret : s)));
    };

    const same = () => {
        const oldProject = projectCtx.projects.find((proj) => proj.id === projectId);
        if (!oldProject) return false;
        const oldEnv = assembleDotenv(oldProject.secrets ?? []);
        const newEnv = assembleDotenv(secrets);
        return JSON.stringify(oldProject) === JSON.stringify(project) && oldEnv === newEnv;
    };

    const saveChanges = async () => {
        if (!project) return;
        notifications.show({
            title: 'Saving Changes',
            message: 'Saving your changes...',
        });
        try {
            await projectCtx.update(project.id, project);
            await projectCtx.updateSecrets(project.id, secrets);
            notifications.show({
                title: 'Success',
                message: 'Project updated successfully',
                color: 'green',
            });
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to save changes',
                color: 'red',
            });
        }
    };

    const handleSyncToRepo = async () => {
        if (!project) return;
        setSyncing(true);
        await projectCtx.syncProjectToRepo(project.id);
        setSyncing(false);
    };

    const handleDeleteProject = async () => {
        if (!project) return;
        try {
            await projectCtx.delete(project.id);
            notifications.show({
                title: 'Success',
                message: 'Project deleted successfully',
                color: 'green',
            });
            navigate('/');
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to delete project',
                color: 'red',
            });
        }
    };

    const handleImportDotenv = () => {
        setImportingDotenv('');
        setModal(null);
        if (!project) return;
        const lines = importingDotenv.split('\n');
        for (const _line of lines) {
            const line = _line.split('#')[0].trim();
            if (!line.length) continue;
            const [key, ...rest] = line.split('=');
            if (!key?.length) continue;
            if (key?.trim().length) {
                const value = rest.join('=');
                const secretKey = key.trim();
                const existing = secrets.find((s) => s.secretName === secretKey);
                if (existing) {
                    setSecrets((prev) => {
                        return prev.map((s) => {
                            return {
                                ...s,
                                secretValue: s.secretName === secretKey ? value : s.secretValue,
                            };
                        });
                    });
                }
            }
        }
        notifications.show({
            title: 'Success',
            message: 'Env file imported successfully',
            color: 'green',
        });
    };

    const handleExportDotenv = () => {
        if (!project) return;
        const dotenvContent = assembleDotenv(secrets);
        const blob = new Blob([dotenvContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${project.id}.env`;
        link.click();
        URL.revokeObjectURL(url);
        notifications.show({
            title: 'Success',
            message: 'Env file exported successfully',
            color: 'green',
        });
    };

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

    if (syncing) {
        return (
            <Center w="100%" h="100%">
                <Stack align="center">
                    <Loader />
                    <Title>Syncing to repository...</Title>
                    <Text>This may take a few moments</Text>
                </Stack>
            </Center>
        );
    }

    const isSame = same();

    return (
        <>
            <Modal opened={modal === 'delete-project'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Delete {project.id}</Title>
                    <Text>Are you sure you want to delete this project? This action cannot be undone.</Text>
                    <Group>
                        <Button variant="outline" onClick={() => setModal(null)}>
                            Cancel
                        </Button>
                        <Button variant="filled" color="red" onClick={handleDeleteProject}>
                            Delete Project
                        </Button>
                    </Group>
                </Stack>
            </Modal>
            <Modal opened={modal === 'import-dotenv'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Import .env file</Title>
                    <Textarea title=".env File Content" placeholder="Paste your .env content here" minRows={6} autosize value={importingDotenv} onChange={(e) => setImportingDotenv(e.currentTarget.value)} />
                    <Group>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setImportingDotenv('');
                                setModal(null);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button variant="filled" onClick={handleImportDotenv}>
                            Import
                        </Button>
                    </Group>
                </Stack>
            </Modal>
            <Stack>
                <ProjectHeader project={project} section="Configuration" />
                {isSame && project.dirtyConfig && (
                    <Alert variant="light" color="yellow" title="Configs Changed">
                        Some configurations have been changed since the last deployment. Redeploy to apply the new settings.
                    </Alert>
                )}
                {!isSame && (
                    <Alert variant="light" color="orange" title="Unsaved Changes">
                        <Group>
                            <Text>You have unsaved changes. Please save your changes before leaving this page.</Text>
                            <Tooltip label="Save Changes (Ctrl+S)">
                                <Button variant="light" color="blue" onClick={saveChanges}>
                                    Save Changes
                                </Button>
                            </Tooltip>
                        </Group>
                    </Alert>
                )}
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
                        description="Which node hosts this project's deployments?"
                        data={clusterCtx.nodes.map((node) => ({ value: node.nodeId, label: `${node.nodeId} (@${node.address})${node.isLeader ? ' • leader' : ''}` }))}
                        onChange={(value) => handleAssignNode(value || undefined)}
                        value={project.workerNodeId ?? null}
                        placeholder="Select a node"
                        nothingFoundMessage="No nodes registered"
                    />
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
                <Divider my="sm" />
                <NginxEditor current={project.nginxConfig || { servers: [] }} onSave={(config) => updateProject({ nginxConfig: config })} project={project} />
                <Divider my="sm" />
                <Group align="center" justify="flex-start">
                    <Title order={4}>System Configuration</Title>
                    <Tooltip label="Sync to Repo">
                        <ActionIcon variant="light" onClick={handleSyncToRepo} size="lg">
                            <MdOutlineRefresh />
                        </ActionIcon>
                    </Tooltip>
                </Group>
                <Group align="center">
                    <Text fz=".75rem" c="dimmed">
                        Pulled from the repository.
                    </Text>
                    <HoverCard position="right" withArrow>
                        <HoverCard.Target>
                            <ActionIcon variant="subtle" size="xs">
                                <MdOutlineInfo />
                            </ActionIcon>
                        </HoverCard.Target>
                        <HoverCard.Dropdown>
                            <Text fz="xs">Environment variable are searched for in order of:</Text>
                            <List fz="xs">
                                <List.Item>
                                    Vars in any file beginning with<Code>.env</Code> (e.g. <Code>.env, .env.sample, .env.production</Code>)
                                </List.Item>
                                <List.Item>
                                    Any text matching <Code>{'${VAR_NAME}'}</Code> in a Docker Compose file (<Code>docker-compose.y(a)ml</Code> or <Code>compose.y(a)ml</Code>)
                                </List.Item>
                                <List.Item>
                                    Any text matching <Code>{'process.env.VAR_NAME'}</Code> in a Javascript or Typescript file (<Code>js, ts, cjs, cts, mjs, mts, jsx, tsx</Code>)
                                    <List.Item>
                                        Note: Only variables in the form of <Code>process.env.VAR_NAME</Code> are detected. More complex usages (e.g. <Code>{`process.env['VAR_NAME']`}</Code>) are not detected.
                                    </List.Item>
                                </List.Item>
                            </List>
                        </HoverCard.Dropdown>
                    </HoverCard>
                </Group>
                <Stack gap="xs">
                    <Group align="center">
                        <Title order={5}>Environment Variables</Title>
                        <Tooltip label="Import .env File">
                            <ActionIcon
                                variant="light"
                                onClick={() => {
                                    setModal('import-dotenv');
                                }}
                            >
                                <MdOutlineUpload />
                            </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Export .env File">
                            <ActionIcon variant="light" onClick={handleExportDotenv}>
                                <MdOutlineDownload />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                    {project.hasDotenv ? (
                        <Grid w="70%">
                            <Grid.Col span={3}>
                                <Title order={6}>Env Variable</Title>
                            </Grid.Col>
                            <Grid.Col span={9}>
                                <Title order={6}>Value</Title>
                            </Grid.Col>
                            {secrets.map((secret) => {
                                return <EnvVarRow key={secret.secretName} secret={secret} onChange={updateSecret} vars={dynamicEnvVariables} />;
                            })}
                        </Grid>
                    ) : (
                        <Alert color="yellow" variant="light" title="No Env File">
                            This root of this project does not have any files starting with `.env`.
                        </Alert>
                    )}
                </Stack>
                <Space h="xl" />
                <Stack gap="xs">
                    <Title order={5}>Docker Compose Services</Title>
                    {!project.hasDockerCompose && (
                        <Alert color="yellow" variant="light" title="No Docker Compose File">
                            This root of this project does not have any files starting with `compose.y(a)ml` or `docker-compose.y(a)ml`.
                        </Alert>
                    )}
                    <Group>
                        {project.services?.map((service) => (
                            <Service
                                key={service.serviceName}
                                service={service}
                                onChange={(updated) => {
                                    const newService = { ...service, ...updated };
                                    const newServices = project.services?.map((s) => (s.serviceName === service.serviceName ? newService : s)) || [];
                                    updateProject({ services: newServices });
                                }}
                            />
                        ))}
                    </Group>
                </Stack>
                <Space h="xl" />
                <Alert color="red" variant="light" title="Danger Zone">
                    <Stack>
                        <Group>
                            <Tooltip label="Delete Project">
                                <Button color="red" variant="outline" onClick={() => setModal('delete-project')}>
                                    Delete Project
                                </Button>
                            </Tooltip>
                        </Group>
                    </Stack>
                </Alert>
            </Stack>
        </>
    );
};

interface EnvVarRowProps {
    secret: Secret;
    onChange: (secret: Secret) => void;
    vars: DynamicEnvVariable[];
}
const EnvVarRow = (props: EnvVarRowProps) => {
    const EnvItems = {
        [NginxConfigLocationType.CUSTOM]: { icon: MdOutlineCode, desc: 'Custom location block', title: 'Custom NGINX Block' },
        [NginxConfigLocationType.REDIRECT]: { icon: MdOutlineLink, desc: 'Redirect requests to another URL', title: 'Redirect Link' },
        [NginxConfigLocationType.PROXY]: { icon: MdOutlineDns, desc: 'Proxy requests to another server', title: 'API Service' },
        [NginxConfigLocationType.STATIC]: { icon: MdOutlineWeb, desc: 'Serve static files from a directory', title: 'Static Page' },
        [UpperDynamicEnvVariableType.GENERAL]: { icon: MdOutlineLan, desc: 'General project setting', title: 'General' },
        [UpperDynamicEnvVariableType.DOMAIN]: { icon: MdOutlineUmbrella, desc: 'The domain of a server block', title: 'Domain' },
    };
    const combobox = useCombobox();
    const { secret } = props;
    const groupedVars: { [key: string]: { vars: DynamicEnvVariable[]; menuItem: (typeof EnvItems)[keyof typeof EnvItems] | undefined } } = {};
    props.vars.forEach((varItem) => {
        const dynVar = parseDynamicVariablePath(varItem.path);
        const parent = `${dynVar.projectId}${dynVar.serverId ? `.${dynVar.serverId}` : ''}${dynVar.locationId ? `.${dynVar.locationId}` : ''}`;
        if (!groupedVars[parent]) {
            groupedVars[parent] = { vars: [], menuItem: varItem.type ? EnvItems[varItem.type] : undefined };
        }
        groupedVars[parent].vars.push(varItem);
    });
    return (
        <>
            <Grid.Col span={3}>
                <Title order={6} ta="right">
                    {secret.secretName}
                </Title>
                {secret.comment && (
                    <Text size="xs" c="dimmed" ta="right" style={{ whiteSpace: 'pre-wrap' }}>
                        {secret.comment}
                    </Text>
                )}
            </Grid.Col>
            <Grid.Col span={9}>
                <Group w="100%">
                    <TextInput
                        flex={1}
                        placeholder={secret.secretPlaceholder}
                        value={secret.variable ? `Linked to ${parseDynamicVariablePath(secret.secretValue).serverId?.split('-')[0] ?? 'Project'} -> ${parseDynamicVariablePath(secret.secretValue).locationId?.split('-')[0] ?? 'Server'} -> ${parseDynamicVariablePath(secret.secretValue).field}` : secret.secretValue}
                        onChange={(event) => props.onChange({ ...secret, secretValue: event.currentTarget.value })}
                        disabled={secret.variable}
                    />
                    <ActionIconGroup>
                        {secret.variable && (
                            <Tooltip label="Unlink Variable">
                                <ActionIcon onClick={() => props.onChange({ ...secret, variable: false, secretValue: '' })} variant="outline">
                                    <MdOutlineLinkOff />
                                </ActionIcon>
                            </Tooltip>
                        )}
                        <Combobox
                            store={combobox}
                            width={350}
                            position="bottom"
                            withArrow
                            onOptionSubmit={(val) => {
                                props.onChange({ ...secret, variable: true, secretValue: `${val}` });
                                combobox.closeDropdown();
                            }}
                        >
                            <Combobox.Target>
                                <ActionIcon onClick={() => combobox.toggleDropdown()} variant="outline">
                                    <MdOutlineLan />
                                </ActionIcon>
                            </Combobox.Target>
                            <Combobox.Dropdown>
                                <Combobox.Header>Link Variable</Combobox.Header>
                                <Combobox.Options>
                                    <ScrollArea.Autosize type="scroll" mah={400}>
                                        {Object.entries(groupedVars).map(([parent, gr], i) => {
                                            const grParts = parent.split('.');
                                            return (
                                                <Combobox.Group
                                                    key={parent}
                                                    label={
                                                        <Stack w="100%">
                                                            {i !== 0 && <Divider my="xs" />}
                                                            <Group align="center">
                                                                {gr.menuItem && <gr.menuItem.icon />}
                                                                <Text fz="xs">
                                                                    {gr.menuItem?.title} {grParts[grParts.length - 1].split('-')[0]}
                                                                </Text>
                                                            </Group>
                                                        </Stack>
                                                    }
                                                >
                                                    {gr.vars.map((varItem) => {
                                                        const dynVar = parseDynamicVariablePath(varItem.path);
                                                        return (
                                                            <Combobox.Option key={varItem.path} value={varItem.path}>
                                                                <Group gap={'xs'}>
                                                                    <Text fz="sm" fw={500}>
                                                                        {`${dynVar.locationId ? `${dynVar.locationId.split('-')[0]}'s ` : ''}${dynVar.field}`}
                                                                    </Text>
                                                                    {!!varItem.placeholder?.length && (
                                                                        <Text fz="xs" c="dimmed">
                                                                            {varItem.placeholder}
                                                                        </Text>
                                                                    )}
                                                                </Group>
                                                            </Combobox.Option>
                                                        );
                                                    })}
                                                </Combobox.Group>
                                            );
                                        })}
                                    </ScrollArea.Autosize>
                                </Combobox.Options>
                            </Combobox.Dropdown>
                        </Combobox>
                    </ActionIconGroup>
                </Group>
            </Grid.Col>
        </>
    );
};

const DockerStatusDescriptions: { [key in DockerStatus]: string } = {
    [DockerStatus.UNKNOWN]: 'Initial state, not yet checked',
    [DockerStatus.CREATED]: 'Container that has never been started.',
    [DockerStatus.RUNNING]: 'Container is running normally.',
    [DockerStatus.PAUSED]: 'Container is paused.',
    [DockerStatus.RESTARTING]: 'Container has stopped and is restarting.',
    [DockerStatus.EXITED]: 'Container has run and stopped gracefully.',
    [DockerStatus.REMOVING]: 'Container is in the process of being removed.',
    [DockerStatus.DEAD]: 'Container is "defunct" and cannot be started.',
};
interface ServiceProps {
    service: ProjectService;
    onChange: (service: Partial<ProjectService>) => void;
}
const Service = (props: ServiceProps) => {
    const { service, onChange } = props;
    const combobox = useCombobox();
    return (
        <Fieldset w={300}>
            <Stack>
                <Title order={6}>{service.serviceName}</Title>
                <Combobox
                    store={combobox}
                    width={500}
                    position="bottom"
                    withArrow
                    onOptionSubmit={(val) => {
                        onChange({ expectedContainerState: val as DockerStatus });
                        combobox.closeDropdown();
                    }}
                >
                    <Combobox.Target>
                        <TextInput label="Expected Container State" value={service.expectedContainerState} readOnly onClick={() => combobox.toggleDropdown()} description={DockerStatusDescriptions[service.expectedContainerState]} />
                    </Combobox.Target>
                    <Combobox.Dropdown>
                        <Combobox.Header>The ending state of a successful container run.</Combobox.Header>
                        <Combobox.Group label="Normal States">
                            {[DockerStatus.RUNNING, DockerStatus.EXITED].map((status) => (
                                <Combobox.Option key={status} value={status}>
                                    <Title order={6}>{status}</Title>
                                    <Text fz="xs">{DockerStatusDescriptions[status]}</Text>
                                </Combobox.Option>
                            ))}
                        </Combobox.Group>
                        <Combobox.Group label="Other States">
                            {[DockerStatus.CREATED, DockerStatus.PAUSED, DockerStatus.RESTARTING, DockerStatus.REMOVING, DockerStatus.DEAD, DockerStatus.UNKNOWN].map((status) => (
                                <Combobox.Option key={status} value={status}>
                                    <Title order={6}>{status}</Title>
                                    <Text fz="xs">{DockerStatusDescriptions[status]}</Text>
                                </Combobox.Option>
                            ))}
                        </Combobox.Group>
                    </Combobox.Dropdown>
                </Combobox>
                <Switch
                    label="Collect Container Logs"
                    description="Should the stdout and stderr of this container be collected and stored?"
                    checked={service.collectContainerLogs}
                    onChange={(event) => {
                        onChange({ collectContainerLogs: event.currentTarget.checked });
                    }}
                />
            </Stack>
        </Fieldset>
    );
};

export default ProjectConfigPage;
