import { Alert, Stack, Title } from '@mantine/core';
import { useCluster } from '@/contexts/cluster-context';
import { LogViewer } from '@/components/LogViewer/LogViewer';

const NsmLogsPage = () => {
    const clusterCtx = useCluster();

    return (
        <Stack>
            <Title order={2}>NSM Logs</Title>
            {!clusterCtx.hasLeader && (
                <Alert color="yellow" variant="light" title="Observability unavailable">
                    Logs are served by the leader. No leader is currently reachable.
                </Alert>
            )}
            <LogViewer selector={{ source: 'nsmd' }} facetFields={['service', 'level', 'area', 'action', 'nodeId']} defaultColumns={['ts', 'level', 'service', 'area', 'action', 'msg']} />
        </Stack>
    );
};

export default NsmLogsPage;
