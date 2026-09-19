import { Alert, Center, Loader, Select, Stack, Title } from '@mantine/core';
import { LogSelector, Project } from '@mosaiq/nsm-common/types';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useProjects } from '@/hooks/queries/useProjects';
import { useCluster } from '@/hooks/queries/useCluster';
import { useProjectInstance } from '@/hooks/queries/projectHooks';
import { ProjectHeader } from '@/components/ProjectHeader';
import { LogViewer } from '@/components/LogViewer/LogViewer';

const PROJECT_SCOPE = '__project__';

const MonitoringLogsPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const { projects } = useProjects();
    const clusterCtx = useCluster();
    const [searchParams] = useSearchParams();

    const [project, setProject] = useState<Project | undefined | null>(undefined);
    const [scope, setScope] = useState<string>(PROJECT_SCOPE);

    useEffect(() => {
        const foundProject = projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
    }, [projectId, projects]);

    // Deep-link support: ?instance=<id> filters logs to a single deployment instance.
    useEffect(() => {
        const requested = searchParams.get('instance');
        if (requested) setScope(requested);
    }, [searchParams]);

    // A service-instance scope requires the full instance to resolve its service instance ids.
    const scopedInstanceId = project?.instances?.find((i) => i.id === scope)?.id;
    const { data: instance } = useProjectInstance(scopedInstanceId);

    const selector = useMemo((): LogSelector => {
        if (scope === PROJECT_SCOPE) return { projectId: projectId };
        if (scope.startsWith('service:')) return { serviceInstanceId: scope.slice('service:'.length) };
        return { projectInstanceId: scope };
    }, [scope, projectId]);

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

    const scopeOptions: { value: string; label: string }[] = [
        { value: PROJECT_SCOPE, label: 'Entire project' },
        ...(project.instances ?? []).map((i) => ({ value: i.id, label: `Instance ${i.id.split('-')[0]} — ${new Date(i.created).toLocaleString()}` })),
        ...(instance?.services ?? []).map((s) => ({ value: `service:${s.instanceId}`, label: `Service: ${s.serviceName}` })),
    ];

    return (
        <Stack>
            <ProjectHeader project={project} section="Logs" />
            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Observability unavailable">
                    Logs are served by the leader. No leader is currently reachable.
                </Alert>
            )}
            <Select label="Scope" data={scopeOptions} value={scope} onChange={(v) => setScope(v || PROJECT_SCOPE)} w={320} />
            <LogViewer selector={selector} facetFields={['serviceName', 'nodeId']} defaultColumns={['ts', 'serviceName', 'msg']} />
        </Stack>
    );
};

export default MonitoringLogsPage;
