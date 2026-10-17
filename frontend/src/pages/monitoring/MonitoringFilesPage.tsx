import { Center, Loader, Stack, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Project } from '@mosaiq/nsm-common/types';
import { useProjects } from '@/hooks/queries/useProjects';
import { ProjectHeader } from '@/components/ProjectHeader';
import { FileExplorer } from '@/components/FileExplorer/FileExplorer';

const MonitoringFilesPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const { projects } = useProjects();
    const [project, setProject] = useState<Project | undefined | null>(undefined);

    useEffect(() => {
        setProject(projects.find((proj) => proj.id === projectId));
    }, [projectId, projects]);

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
            <ProjectHeader project={project} section="Files" />
            <FileExplorer projectId={project.id} />
        </Stack>
    );
};

export default MonitoringFilesPage;
