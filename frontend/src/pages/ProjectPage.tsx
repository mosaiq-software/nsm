import { Badge, Button, Card, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProjects } from '@/contexts/project-context';
import { useCluster } from '@/contexts/cluster-context';
import { ProjectHeader } from '@/components/ProjectHeader';
import { DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { MdOutlineRocketLaunch, MdOutlineSettings, MdOutlineViewList } from 'react-icons/md';

const stateColor = (state?: DeploymentState) => {
    switch (state) {
        case DeploymentState.HEALTHY:
        case DeploymentState.DEPLOYED:
            return 'green';
        case DeploymentState.DEPLOYING:
            return 'blue';
        case DeploymentState.FAILED:
            return 'red';
        case DeploymentState.DESTROYING:
            return 'orange';
        default:
            return 'gray';
    }
};

const ProjectPage = () => {
    const params = useParams();
    const projectId = params.projectId;
    const projectCtx = useProjects();
    const clusterCtx = useCluster();
    const [project, setProject] = useState<Project | undefined | null>(undefined);

    useEffect(() => {
        const foundProject = projectCtx.projects.find((proj) => proj.id === projectId);
        setProject(foundProject);
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

    const assignedNode = clusterCtx.nodes.find((n) => n.nodeId === project.workerNodeId);

    return (
        <Stack>
            <ProjectHeader project={project} section="Overview" />
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            State
                        </Text>
                        <Badge color={stateColor(project.state)} size="lg">
                            {project.state ?? 'unknown'}
                        </Badge>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            Assigned Node
                        </Text>
                        <Text fw={600}>{project.workerNodeId ? `${project.workerNodeId}${assignedNode ? ` (@${assignedNode.address})` : ''}` : 'Unassigned'}</Text>
                    </Stack>
                </Card>
                <Card withBorder>
                    <Stack gap="xs">
                        <Text c="dimmed" size="sm">
                            Repository
                        </Text>
                        <Text fw={600}>
                            {project.repoOwner}/{project.repoName}
                            {project.repoBranch ? `@${project.repoBranch}` : ''}
                        </Text>
                    </Stack>
                </Card>
            </SimpleGrid>
            <Group>
                <Button component={Link} to={`/p/${project.id}/config`} variant="light" leftSection={<MdOutlineSettings />}>
                    Configure
                </Button>
                <Button component={Link} to={`/p/${project.id}/deploy`} variant="light" color="green" leftSection={<MdOutlineRocketLaunch />}>
                    Deploy
                </Button>
                <Button component={Link} to={`/p/${project.id}/logs`} variant="light" leftSection={<MdOutlineViewList />}>
                    Logs & Metrics
                </Button>
            </Group>
        </Stack>
    );
};

export default ProjectPage;
