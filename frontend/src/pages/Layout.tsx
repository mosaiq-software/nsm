import React, { useEffect, useState } from 'react';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { AppShell, Autocomplete, Avatar, Burger, Button, Center, Divider, FileInput, Group, Loader, Menu, Modal, Space, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import RouterLink from '@/components/RouterLink';
import { useProjects } from '@/contexts/project-context';
import { Link, useNavigate } from 'react-router-dom';
import { GithubOwner, Project } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useUser } from '@/contexts/user-context';
import { rawApiGetNoHook, useAPI } from '@/utils/api';

const Layout = (props: { children: React.ReactNode }) => {
    const [opened, { toggle }] = useDisclosure();
    const projectCtx = useProjects();
    const userCtx = useUser();
    const navigate = useNavigate();
    const [modal, setModal] = useState<'create' | null>(null);
    const [creatingProject, setCreatingProject] = useState(false);
    const [legacyFile, setLegacyFile] = useState<File | null>(null);
    const [newProject, setNewProject] = useState<Project>({
        id: '',
        repoOwner: 'mosaiq-software',
        repoName: '',
        repoBranch: '',
        allowCICD: false,
    });

    const handleLegacyFile = async (file: File | null) => {
        setLegacyFile(file);
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            if (!parsed || parsed.__nsmLegacyConfig !== 1) {
                throw new Error('Not a valid NSM legacy config file');
            }
            setNewProject((prev) => ({
                ...prev,
                id: parsed.id ?? prev.id,
                repoOwner: parsed.repoOwner ?? prev.repoOwner,
                repoName: parsed.repoName ?? prev.repoName,
                repoBranch: parsed.repoBranch ?? prev.repoBranch,
                allowCICD: parsed.allowCICD ?? prev.allowCICD,
                timeout: parsed.timeout,
                nginxConfig: parsed.nginxConfig,
                services: parsed.services,
                secrets: parsed.secrets,
            }));
            notifications.show({
                title: 'Legacy config loaded',
                message: `Loaded config from ${file.name}. Values will be applied after the repo sync.`,
                color: 'green',
            });
        } catch (error) {
            setLegacyFile(null);
            notifications.show({
                title: 'Invalid config file',
                message: error instanceof Error ? error.message : 'Failed to parse the uploaded file',
                color: 'red',
            });
        }
    };

    const { token } = useAPI();
    const [owners, setOwners] = useState<GithubOwner[]>([]);
    const [repos, setRepos] = useState<string[]>([]);
    const [branches, setBranches] = useState<string[]>([]);
    // Debounce the free-text owner/repo so typing doesn't fire a GitHub lookup on every keystroke.
    const [debouncedOwner] = useDebouncedValue(newProject.repoOwner?.trim() || '', 400);
    const [debouncedRepo] = useDebouncedValue(newProject.repoName?.trim() || '', 400);

    // Owners that installed the GitHub App: loaded once when the modal opens.
    useEffect(() => {
        if (modal !== 'create') return;
        let cancelled = false;
        void rawApiGetNoHook(API_ROUTES.GET_GITHUB_OWNERS, {}, token).then((res) => {
            if (!cancelled && res) setOwners(res);
        });
        return () => {
            cancelled = true;
        };
    }, [modal, token]);

    // Repos the App can access for the chosen owner.
    useEffect(() => {
        if (modal !== 'create' || !debouncedOwner) {
            setRepos([]);
            return;
        }
        let cancelled = false;
        void rawApiGetNoHook(API_ROUTES.GET_GITHUB_REPOS, {}, token, { owner: debouncedOwner }).then((res) => {
            if (!cancelled) setRepos(res || []);
        });
        return () => {
            cancelled = true;
        };
    }, [modal, debouncedOwner, token]);

    // Branches of the chosen repo.
    useEffect(() => {
        if (modal !== 'create' || !debouncedOwner || !debouncedRepo) {
            setBranches([]);
            return;
        }
        let cancelled = false;
        void rawApiGetNoHook(API_ROUTES.GET_GITHUB_BRANCHES, {}, token, { owner: debouncedOwner, repo: debouncedRepo }).then((res) => {
            if (!cancelled) setBranches(res || []);
        });
        return () => {
            cancelled = true;
        };
    }, [modal, debouncedOwner, debouncedRepo, token]);

    return (
        <>
            <Modal opened={modal === 'create'} onClose={() => setModal(null)} withCloseButton={false} closeOnClickOutside={!creatingProject}>
                {creatingProject ? (
                    <Center>
                        <Stack align="center">
                            <Loader />
                            <Text>Creating project...</Text>
                        </Stack>
                    </Center>
                ) : (
                    <Stack>
                        <Title order={3}>Create Project</Title>
                        <FileInput
                            label="Upload legacy config (optional)"
                            description="Import a config downloaded from the legacy server-manager. Fills in the fields below and restores env vars, domains, services, and expected states after the repo sync."
                            placeholder="Select .nsm-config.json"
                            accept="application/json,.json"
                            clearable
                            value={legacyFile}
                            onChange={handleLegacyFile}
                        />
                        <TextInput
                            label="Project ID"
                            placeholder="terrazzo"
                            description="The unique identifier for the project. Cannot be changed later."
                            value={newProject?.id || ''}
                            onChange={(e) => setNewProject({ ...newProject, id: e.target.value })}
                        />
                        <Autocomplete
                            label="Repo Owner"
                            placeholder="mosaiq-software"
                            description="Accounts/orgs that installed the NSM GitHub App. You can also type any owner."
                            data={owners.map((o) => o.login)}
                            value={newProject?.repoOwner || ''}
                            onChange={(value) => setNewProject({ ...newProject, repoOwner: value })}
                        />
                        <Autocomplete
                            label="Repo Name"
                            placeholder="terrazzo-api"
                            description="Repositories the GitHub App can access for this owner. You can also type any name."
                            data={repos}
                            value={newProject?.repoName || ''}
                            onChange={(value) => setNewProject({ ...newProject, repoName: value })}
                        />
                        <Autocomplete
                            label="Repo Branch"
                            placeholder="main"
                            description="Branches in the selected repo. Defaults to the repo default branch if not set."
                            data={branches}
                            value={newProject?.repoBranch || ''}
                            onChange={(value) => setNewProject({ ...newProject, repoBranch: value })}
                        />
                        {newProject.repoOwner && newProject.repoName && (
                            <Link to={`https://github.com/${newProject.repoOwner}/${newProject.repoName}`} target="_blank">{`https://github.com/${newProject.repoOwner}/${newProject.repoName}`}</Link>
                        )}
                        <Switch label="Allow CI/CD" checked={newProject?.allowCICD || false} onChange={(e) => setNewProject({ ...newProject, allowCICD: e.currentTarget.checked })} />
                        <Group justify="space-between">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    setModal(null);
                                    setLegacyFile(null);
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="filled"
                                onClick={async () => {
                                    setCreatingProject(true);
                                    await projectCtx.create(newProject);
                                    await new Promise((resolve) => setTimeout(resolve, 1000));
                                    setCreatingProject(false);
                                    setModal(null);
                                    setLegacyFile(null);
                                    navigate(`/p/${newProject.id}`);
                                }}
                            >
                                Create
                            </Button>
                        </Group>
                    </Stack>
                )}
            </Modal>
            <AppShell
                padding="md"
                header={{ height: 60 }}
                navbar={{
                    width: 300,
                    breakpoint: 'sm',
                    collapsed: { mobile: !opened },
                }}
            >
                <AppShell.Header
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'nowrap',
                    }}
                    px="1rem"
                >
                    <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />

                    <Group h="100%" align="center">
                        <Avatar src="/favicon.svg" />
                        <Text>
                            <span style={{ fontWeight: '900' }}>N</span>ode <span style={{ fontWeight: '900' }}>S</span>erver <span style={{ fontWeight: '900' }}>M</span>anager
                        </Text>
                    </Group>
                    <Menu>
                        <Menu.Target>
                            <Avatar
                                src={userCtx.user?.avatarUrl || undefined}
                                style={{ cursor: 'pointer' }}
                                onClick={() => {
                                    if (!userCtx.user) {
                                        userCtx.signIn();
                                    }
                                }}
                            />
                        </Menu.Target>
                        {userCtx.user && (
                            <Menu.Dropdown>
                                <Menu.Item
                                    component="a"
                                    onClick={() => {
                                        userCtx.signOut();
                                    }}
                                >
                                    Logout
                                </Menu.Item>
                            </Menu.Dropdown>
                        )}
                    </Menu>
                </AppShell.Header>

                <AppShell.Navbar
                    p="md"
                    style={{
                        height: `calc(100dvh - var(--app-shell-header-height) - 1px)`,
                        overflowY: 'auto',
                    }}
                >
                    <RouterLink to="/" label="Dashboard" showActive />
                    <RouterLink to="/nodes" label="Nodes" showActive />
                    <RouterLink to="/status" label="Cluster Status" showActive />
                    <RouterLink to="/access" label="Access Management" showActive />
                    <Space h="md" />
                    <Divider w="80%" mx="auto" my="sm" />
                    {projectCtx.projects.map((project) => (
                        <RouterLink to={`/p/${project.id}`} label={`${project.id}`} key={project.id} showActive>
                            <RouterLink to={`/p/${project.id}/config`} label="Config" showActive />
                            <RouterLink to={`/p/${project.id}/deploy`} label="Deploy" showActive />
                            <RouterLink to={`/p/${project.id}/logs`} label="Logs" showActive />
                        </RouterLink>
                    ))}
                    <Space h="md" />
                    <Button onClick={() => setModal('create')} variant="outline" style={{ flexShrink: '0' }}>
                        Create Project
                    </Button>
                </AppShell.Navbar>

                <AppShell.Main>{props.children}</AppShell.Main>
            </AppShell>
        </>
    );
};

export default Layout;
