import { Alert, Button, Center, Loader, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { DynamicEnvVariable, PortReservation, Project, Secret } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useAPI } from '@/utils/api';
import { ProjectHeader } from '@/components/ProjectHeader';
import { assembleDotenv, extractVariables } from '@mosaiq/nsm-common/secretUtil';
import { ProjectConfigContext, ProjectConfigContextValue } from './projectConfigContext';

const ProjectConfigLayout = () => {
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const api = useAPI();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [secrets, setSecrets] = useState<Secret[]>([]);
    const [dynamicEnvVariables, setDynamicEnvVariables] = useState<DynamicEnvVariable[]>([]);
    const [portReservations, setPortReservations] = useState<PortReservation[]>([]);

    useEffect(() => {
        const foundProject = projectCtx.projects.find((proj) => proj.id === projectId);
        if (foundProject) {
            const vars = extractVariables(foundProject);
            setProject({ ...foundProject });
            setDynamicEnvVariables(vars);
            setSecrets(foundProject.secrets ?? []);
        } else {
            setProject(foundProject);
        }
    }, [projectId, projectCtx.projects]);

    useEffect(() => {
        if (!projectId || !api.token) return;
        void api.get(API_ROUTES.GET_PROJECT_PORT_RESERVATIONS, { projectId }).then((res) => setPortReservations(res ?? []));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, api.token]);

    const updateProject = (updatedFields: Partial<Project>) => {
        setProject((prev) => {
            if (!prev) return prev;
            const next = { ...prev, ...updatedFields };
            setDynamicEnvVariables(extractVariables(next));
            return next;
        });
    };

    const updateSecret = (secret: Secret) => {
        setSecrets((prev) => {
            if (!prev.find((s) => s.secretName === secret.secretName)) return prev;
            return prev.map((s) => (s.secretName === secret.secretName ? secret : s));
        });
    };

    const same = (): boolean => {
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

    const isSame = project ? same() : true;

    useWindowEvent('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            event.stopPropagation();
            if (!isSame) {
                void saveChanges();
            }
        }
    });

    const contextValue = useMemo<ProjectConfigContextValue | null>(() => {
        if (!project || !project.id || !projectId) return null;
        return {
            project,
            projectId,
            updateProject,
            secrets,
            setSecrets,
            updateSecret,
            dynamicEnvVariables,
            portReservations,
            isSame,
            saveChanges,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project, projectId, secrets, dynamicEnvVariables, portReservations, isSame]);

    if (project === undefined) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }

    if (!project || !project.id || !contextValue) {
        return (
            <Center>
                <Stack>
                    <Title order={4}>Project &quot;{projectId}&quot; not found!</Title>
                </Stack>
            </Center>
        );
    }

    return (
        <ProjectConfigContext.Provider value={contextValue}>
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
                <Outlet />
            </Stack>
        </ProjectConfigContext.Provider>
    );
};

export default ProjectConfigLayout;
