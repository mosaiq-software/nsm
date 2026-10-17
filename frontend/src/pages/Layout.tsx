import React, { useState } from 'react';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { AppShell, Autocomplete, Avatar, Burger, Button, Center, Group, Loader, Menu, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import Sidebar from '@/components/Sidebar/Sidebar';
import TeamSwitcher from '@/components/Sidebar/TeamSwitcher';
import { useCreateProject } from '@/hooks/mutations/projectMutations';
import { useMe } from '@/hooks/queries/useMe';
import { useGithubRepos, useGithubBranches } from '@/hooks/queries/githubHooks';
import { Link, useNavigate } from 'react-router-dom';
import { Project } from '@mosaiq/nsm-common/types';
import { useUser } from '@/contexts/user-context';

const emptyProject: Project = {
    id: '',
    repoOwner: '',
    repoName: '',
    repoBranch: '',
    allowCICD: false,
};

const Layout = (props: { children: React.ReactNode }) => {
    const [opened, { toggle, close }] = useDisclosure();
    const createProject = useCreateProject();
    const meCtx = useMe();
    const userCtx = useUser();
    const navigate = useNavigate();
    const [modal, setModal] = useState<'create' | null>(null);
    const [creatingProject, setCreatingProject] = useState(false);
    const [newProject, setNewProject] = useState<Project>(emptyProject);

    const closeCreateModal = () => {
        setModal(null);
        setNewProject(emptyProject);
    };

    const openCreateModal = (ownerLogin: string) => {
        setNewProject({ ...emptyProject, repoOwner: ownerLogin });
        setModal('create');
    };

    // Debounce the free-text owner/repo so typing doesn't fire a GitHub lookup on every keystroke.
    const [debouncedOwner] = useDebouncedValue(newProject.repoOwner?.trim() || '', 400);
    const [debouncedRepo] = useDebouncedValue(newProject.repoName?.trim() || '', 400);

    const isCreateModalOpen = modal === 'create';
    const repos = useGithubRepos(debouncedOwner, isCreateModalOpen).data ?? [];
    const branches = useGithubBranches(debouncedOwner, debouncedRepo, isCreateModalOpen).data ?? [];

    return (
        <>
            <Modal opened={modal === 'create'} onClose={closeCreateModal} withCloseButton={false} closeOnClickOutside={!creatingProject}>
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
                        <TextInput
                            label="Project ID"
                            placeholder="terrazzo"
                            description="The unique identifier for the project. Cannot be changed later."
                            value={newProject?.id || ''}
                            onChange={(e) => setNewProject({ ...newProject, id: e.target.value })}
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
                        <Group justify="space-between">
                            <Button
                                variant="outline"
                                onClick={closeCreateModal}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="filled"
                                onClick={async () => {
                                    const createdId = newProject.id;
                                    setCreatingProject(true);
                                    try {
                                        await createProject.mutateAsync(newProject);
                                    } catch {
                                        // Notification handled by the mutation hook.
                                        setCreatingProject(false);
                                        return;
                                    }
                                    await meCtx.refresh();
                                    await new Promise((resolve) => setTimeout(resolve, 1000));
                                    setCreatingProject(false);
                                    closeCreateModal();
                                    navigate(`/p/${createdId}`);
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
                    <Group h="100%" align="center" gap="sm" wrap="nowrap">
                        <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
                        <Avatar src="/favicon.svg" />
                        <TeamSwitcher onNavigate={close} />
                    </Group>
                    <Group align="center" gap="md">
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
                                    <Menu.Item component={Link} to="/settings">
                                        Settings
                                    </Menu.Item>
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
                    </Group>
                </AppShell.Header>

                <AppShell.Navbar
                    p="md"
                    style={{
                        height: `calc(100dvh - var(--app-shell-header-height) - 1px)`,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    }}
                >
                    <Sidebar onCreateProject={openCreateModal} onNavigate={close} />
                </AppShell.Navbar>

                <AppShell.Main>{props.children}</AppShell.Main>
            </AppShell>
        </>
    );
};

export default Layout;
