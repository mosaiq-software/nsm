import { Alert, Card, Stack, Title } from '@mantine/core';
import { useProjects } from '@/hooks/queries/useProjects';
import { useMe } from '@/hooks/queries/useMe';
import { ResourceAllocationEditor } from '@/components/ResourceAllocation';
import { useProjectConfig } from './projectConfigContext';

const ConfigResourcesPage = () => {
    const { project } = useProjectConfig();
    const projectCtx = useProjects();
    const meCtx = useMe();

    if (!meCtx.isAdmin) {
        return (
            <Alert color="yellow" variant="light" title="Admin only">
                Resource allocation can only be edited by administrators.
            </Alert>
        );
    }

    return (
        <Card withBorder>
            <Stack gap="sm">
                <Title order={5}>Resource Allocation</Title>
                <ResourceAllocationEditor projectId={project.id} quota={project.resourceQuota} onSaved={() => projectCtx.refresh()} />
            </Stack>
        </Card>
    );
};

export default ConfigResourcesPage;
