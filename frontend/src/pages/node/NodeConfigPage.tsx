import { Alert, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { MdOutlineSettings } from 'react-icons/md';
import { useCluster } from '@/hooks/queries/useCluster';
import { useMe } from '@/hooks/queries/useMe';
import { NodeConfigModal } from '@/components/NodeConfigModal';
import { NodePortAllocationCard } from '@/components/NodePortAllocationCard';

const NodeConfigPage = () => {
    const params = useParams();
    const nodeId = params.nodeId as string;
    const clusterCtx = useCluster();
    const meCtx = useMe();
    const [configOpen, setConfigOpen] = useState(false);

    const node = clusterCtx.nodes.find((n) => n.nodeId === nodeId);

    // Re-verify admin against a fresh /me before opening the editor (the modal, backend route, and
    // node RPC all re-check too; this is the first of the layered checks).
    const openConfig = async () => {
        await meCtx.refresh();
        if (!meCtx.isAdmin) return;
        setConfigOpen(true);
    };

    if (!meCtx.isAdmin) {
        return (
            <Alert color="yellow" variant="light" title="Admin only">
                Node configuration can only be edited by administrators.
            </Alert>
        );
    }

    return (
        <Stack>
            <Card withBorder>
                <Group justify="space-between" align="center" wrap="nowrap">
                    <Stack gap={2}>
                        <Title order={4}>Configuration</Title>
                        <Text size="sm" c="dimmed">
                            Edit this node's environment variables. Saving rewrites the node's nsm.env and restarts the daemon to apply the changes.
                        </Text>
                    </Stack>
                    <Button leftSection={<MdOutlineSettings />} variant="light" onClick={openConfig}>
                        Edit configuration
                    </Button>
                </Group>
            </Card>

            {configOpen && <NodeConfigModal nodeId={nodeId} isLeader={!!node?.isLeader} isAdmin={meCtx.isAdmin} onClose={() => setConfigOpen(false)} />}

            <NodePortAllocationCard nodeId={nodeId} />
        </Stack>
    );
};

export default NodeConfigPage;
