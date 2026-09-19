import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Project, ProjectResourceQuota, Secret } from '@mosaiq/nsm-common/types';

// Patch the cached projects list in place. Used for client-only/optimistic config edits that must not
// trigger a network round-trip and must survive until the next explicit refresh. Mirrors the old
// context's handleUpdateProject(clientOnly) behaviour: merge fields and mark the project dirty.
export const usePatchProjectCache = () => {
    const queryClient = useQueryClient();
    return (id: string, patch: Partial<Project>) => {
        queryClient.setQueryData<Project[]>(queryKeys.projects(), (prev) =>
            (prev ?? []).map((proj) => (proj.id === id ? { ...proj, dirtyConfig: true, ...patch } : proj))
        );
    };
};

export const useCreateProject = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (newProject: Project) => {
            const created = await api.post(API_ROUTES.POST_CREATE_PROJECT, {}, newProject);
            if (!created) throw new Error('Creation failed');
            return created;
        },
        onSuccess: (created) => {
            queryClient.setQueryData<Project[]>(queryKeys.projects(), (prev) => [...(prev ?? []), created]);
            void queryClient.invalidateQueries({ queryKey: queryKeys.projectStatuses() });
            notifications.show({ title: 'Success', message: 'Project created successfully', color: 'green' });
        },
        onError: () => {
            notifications.show({ title: 'Error', message: 'Failed to create project', color: 'red' });
        },
    });
};

// Persist a project config update, then optimistically mark it dirty in the cache.
export const useUpdateProject = () => {
    const api = useAPI();
    const patchCache = usePatchProjectCache();
    return useMutation({
        mutationFn: async ({ id, patch }: { id: string; patch: Partial<Project> }) => {
            await api.post(API_ROUTES.POST_UPDATE_PROJECT, { projectId: id }, patch);
            return { id, patch };
        },
        onSuccess: ({ id, patch }) => patchCache(id, patch),
    });
};

// Persist each changed secret, then optimistically merge them into the cached project.
export const useUpdateSecrets = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ projectId, secrets }: { projectId: string; secrets: Secret[] }) => {
            for (const secret of secrets) {
                await api.post(API_ROUTES.POST_UPDATE_ENV_VAR, { projectId }, secret);
            }
            return { projectId, secrets };
        },
        onSuccess: ({ projectId, secrets }) => {
            queryClient.setQueryData<Project[]>(queryKeys.projects(), (prev) =>
                (prev ?? []).map((proj) =>
                    proj.id === projectId
                        ? {
                              ...proj,
                              dirtyConfig: true,
                              secrets: proj.secrets?.map((existing) => {
                                  const updated = secrets.find((s) => s.secretName === existing.secretName);
                                  return updated ? { ...existing, ...updated } : existing;
                              }),
                          }
                        : proj
                )
            );
        },
    });
};

export const useSyncProjectToRepo = () => {
    const api = useAPI();
    const patchCache = usePatchProjectCache();
    return useMutation({
        mutationFn: async (projectId: string) => {
            const updated = await api.post(API_ROUTES.POST_SYNC_TO_REPO, { projectId }, {});
            if (!updated) throw new Error('Sync failed');
            return { projectId, updated };
        },
        onSuccess: ({ projectId, updated }) => {
            patchCache(projectId, updated);
            notifications.show({ title: 'Success', message: 'Project synced successfully', color: 'green' });
        },
        onError: () => {
            notifications.show({ title: 'Error', message: 'Failed to sync project', color: 'red' });
        },
    });
};

export const useDeleteProject = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            await api.post(API_ROUTES.POST_DELETE_PROJECT, { projectId: id }, {});
            return id;
        },
        onSuccess: (id) => {
            queryClient.setQueryData<Project[]>(queryKeys.projects(), (prev) => (prev ?? []).filter((proj) => proj.id !== id));
            void queryClient.invalidateQueries({ queryKey: queryKeys.projectStatuses() });
        },
    });
};

// Set a project's advisory resource allocation, then refresh the project list so the new quota shows.
export const useSetProjectQuota = (projectId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: ProjectResourceQuota) => api.post(API_ROUTES.POST_SET_PROJECT_QUOTA, { projectId }, body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    });
};

// Assign a project to a worker node, then optimistically patch the cache.
export const useSetProjectAssignment = () => {
    const api = useAPI();
    const patchCache = usePatchProjectCache();
    return useMutation({
        mutationFn: async ({ projectId, nodeId }: { projectId: string; nodeId: string }) => {
            await api.post(API_ROUTES.POST_SET_PROJECT_ASSIGNMENT, { projectId }, { nodeId });
            return { projectId, nodeId };
        },
        onSuccess: ({ projectId, nodeId }) => patchCache(projectId, { workerNodeId: nodeId }),
    });
};
