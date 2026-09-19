import { Center, Loader, Stack, Title } from '@mantine/core';
import { Project } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { ProjectHeader } from '@/components/ProjectHeader';
import { IncidentSection } from '@/components/IncidentSection';

const MonitoringIncidentsPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const [project, setProject] = useState<Project | undefined | null>(undefined);

    useEffect(() => {
        setProject(projectCtx.projects.find((proj) => proj.id === projectId));
    }, [projectId, projectCtx.projects]);

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

    return (
        <Stack>
            <ProjectHeader project={project} section="Incidents" />
            <IncidentSection projectId={project.id} />
        </Stack>
    );
};

export default MonitoringIncidentsPage;
