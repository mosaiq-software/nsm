import { useAPI } from '@/utils/api';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DeploymentState, Project, Secret } from '@mosaiq/nsm-common/types';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { deriveProjectState } from '@/utils/projectStatus';

type ProjectContextType = {
    projects: Project[];
    statusById: Record<string, DeploymentState>;
    refresh: () => Promise<void>;
    create: (newProject: Project) => Promise<void>;
    update: (id: string, updatedProject: Partial<Project>, clientOnly?: boolean) => Promise<void>;
    delete: (id: string) => Promise<void>;
    updateSecrets: (projectId: string, secrets: Secret[]) => Promise<void>;
    syncProjectToRepo: (projectId: string) => Promise<void>;
};

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

const STATUS_POLL_MS = 5000;

const deriveStatusMap = (projects: Project[]): Record<string, DeploymentState> => {
    const map: Record<string, DeploymentState> = {};
    for (const project of projects) map[project.id] = deriveProjectState(project);
    return map;
};

const ProjectProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const [projects, setProjects] = useState<Project[]>([]);
    const [statusById, setStatusById] = useState<Record<string, DeploymentState>>({});
    const api = useAPI();
    const tokenRef = useRef<string | undefined>(api.token);
    tokenRef.current = api.token;

    const refresh = async () => {
        try {
            const response = await api.get(API_ROUTES.GET_PROJECTS, {});
            if (!response) {
                return;
            }
            setProjects(response);
            setStatusById(deriveStatusMap(response));
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to fetch projects',
                color: 'red',
            });
        }
    };

    // Keep the sidebar status chips fresh without replacing `projects` (which would clobber
    // unsaved edits on the config page). Only the derived status map is updated here.
    const fetchStatuses = async () => {
        const response = await api.get(API_ROUTES.GET_PROJECTS, {});
        if (response) setStatusById(deriveStatusMap(response));
    };

    useEffect(() => {
        if (!api.token) {
            setProjects([]);
            setStatusById({});
            return;
        }
        refresh();
        const interval = setInterval(() => {
            if (tokenRef.current) fetchStatuses();
        }, STATUS_POLL_MS);
        return () => clearInterval(interval);
    }, [api.token]);

    const handleCreateProject = async (newProject: Project) => {
        try {
            const created = await api.post(API_ROUTES.POST_CREATE_PROJECT, {}, newProject);
            if (!created) {
                throw new Error('Creation failed');
            }
            setProjects((prev) => [...prev, created]);
            notifications.show({
                title: 'Success',
                message: 'Project created successfully',
                color: 'green',
            });
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to create project',
                color: 'red',
            });
        }
    };

    const handleUpdateProject = async (id: string, updatedProject: Partial<Project>, clientOnly?: boolean) => {
        if (!clientOnly) {
            await api.post(API_ROUTES.POST_UPDATE_PROJECT, { projectId: id }, updatedProject);
        }
        setProjects((prev) => prev.map((proj) => (proj.id === id ? { ...proj, dirtyConfig: true, ...updatedProject } : proj)));
    };

    const updateSecrets = async (projectId: string, secrets: Secret[]) => {
        for (const secret of secrets) {
            await api.post(API_ROUTES.POST_UPDATE_ENV_VAR, { projectId }, secret);
            setProjects((prev) =>
                prev.map((proj) =>
                    proj.id === projectId
                        ? {
                              ...proj,
                              dirtyConfig: true,
                              secrets: proj.secrets?.map((existing) => {
                                  const updatedSecret = secrets.find((s) => s.secretName === existing.secretName);
                                  return updatedSecret ? { ...existing, ...updatedSecret } : existing;
                              }),
                          }
                        : proj
                )
            );
        }
    };

    const syncProjectToRepo = async (projectId: string) => {
        try {
            const updatedProject = await api.post(API_ROUTES.POST_SYNC_TO_REPO, { projectId }, {});
            if (!updatedProject) {
                throw new Error('Sync failed');
            }
            handleUpdateProject(projectId, updatedProject, true);
            notifications.show({
                title: 'Success',
                message: 'Project synced successfully',
                color: 'green',
            });
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to sync project',
                color: 'red',
            });
        }
    };

    const handleDeleteProject = async (id: string) => {
        try {
            await api.post(API_ROUTES.POST_DELETE_PROJECT, { projectId: id }, {});
            setProjects((prev) => prev.filter((proj) => proj.id !== id));
            notifications.show({
                title: 'Success',
                message: 'Project deleted successfully',
                color: 'green',
            });
        } catch (error) {
            notifications.show({
                title: 'Error',
                message: 'Failed to delete project',
                color: 'red',
            });
        }
    };

    return (
        <ProjectContext.Provider
            value={{
                projects,
                statusById,
                refresh,
                create: handleCreateProject,
                update: handleUpdateProject,
                delete: handleDeleteProject,
                updateSecrets,
                syncProjectToRepo,
            }}
        >
            {children}
        </ProjectContext.Provider>
    );
};

const useProjects = () => {
    const context = useContext(ProjectContext);
    if (context === undefined) {
        throw new Error('useProjects must be used within a ProjectProvider');
    }
    return context;
};

export { ProjectProvider, useProjects };
