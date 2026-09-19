import { ActionIcon, Badge, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PortProtocol, PortReservation } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdOutlineDelete } from 'react-icons/md';
import { useNodePortReservations } from '@/hooks/queries/nodeHooks';
import { useProjects } from '@/hooks/queries/useProjects';
import { useCreateNodePortReservation, useDeleteNodePortReservation } from '@/hooks/mutations/nodeMutations';

interface NodePortAllocationCardProps {
    nodeId: string;
}

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PROTOCOL_OPTIONS = [
    { value: PortProtocol.TCP, label: 'TCP' },
    { value: PortProtocol.UDP, label: 'UDP' },
];

// Admin-only editor for a node's directly-forwarded port reservations. Each entry reserves a fixed
// host port+protocol on this node for one project; NSM keeps it out of the dynamic proxy pool and
// injects it as an env var when that project deploys here.
export const NodePortAllocationCard = ({ nodeId }: NodePortAllocationCardProps) => {
    const reservationsQuery = useNodePortReservations(nodeId);
    const { projects } = useProjects();
    const createReservation = useCreateNodePortReservation(nodeId);
    const deleteReservation = useDeleteNodePortReservation(nodeId);

    const reservations = reservationsQuery.data ?? null;
    const busy = createReservation.isPending || deleteReservation.isPending;

    const [port, setPort] = useState<number | ''>('');
    const [protocol, setProtocol] = useState<PortProtocol>(PortProtocol.TCP);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [envVarName, setEnvVarName] = useState('');
    const [label, setLabel] = useState('');

    const projectName = (id: string) => projects.find((p) => p.id === id)?.id ?? id;

    const validate = (): string | null => {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be an integer between 1 and 65535.';
        if (!projectId) return 'Select a project to reserve the port for.';
        if (!ENV_VAR_RE.test(envVarName.trim())) return 'Environment variable name must start with a letter or underscore and contain only letters, digits, and underscores.';
        const existing = reservations ?? [];
        if (existing.some((r) => r.port === port && r.protocol === protocol)) return `Port ${port}/${protocol} is already reserved on ${nodeId}.`;
        if (existing.some((r) => r.projectId === projectId && r.envVarName === envVarName.trim())) return `Environment variable ${envVarName.trim()} is already used by another reservation for this project on ${nodeId}.`;
        return null;
    };

    const add = async () => {
        const err = validate();
        if (err) {
            notifications.show({ color: 'red', message: err });
            return;
        }
        try {
            await createReservation.mutateAsync({ port: port as number, protocol, projectId: projectId as string, envVarName: envVarName.trim(), label: label.trim() || undefined });
            notifications.show({ color: 'green', message: `Reserved ${port}/${protocol} for ${projectName(projectId as string)}.` });
            setPort('');
            setEnvVarName('');
            setLabel('');
            setProjectId(null);
        } catch {
            notifications.show({ color: 'red', message: 'Failed to reserve port. It may already be in use or reserved by NSM.' });
        }
    };

    const remove = async (r: PortReservation) => {
        if (!window.confirm(`Delete reservation ${r.port}/${r.protocol} (${r.envVarName}) for ${projectName(r.projectId)}?`)) return;
        await deleteReservation.mutateAsync(r.id);
    };

    return (
        <Card withBorder mt="md">
            <Stack gap="sm">
                <Stack gap={2}>
                    <Title order={4}>Port allocation</Title>
                    <Text size="sm" c="dimmed">
                        Reserve fixed host ports forwarded to this node for a specific project. Reserved ports are kept out of the dynamic proxy pool and injected as environment variables (host port = forwarded port) when the project deploys here. Publish them in your compose, e.g. <Text span ff="monospace">{'${ENV}:25565/udp'}</Text>. NSM does not configure your router; add the matching forwarding rule there.
                    </Text>
                </Stack>

                <Table striped withRowBorders={false} verticalSpacing="xs" fz="sm">
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Port</Table.Th>
                            <Table.Th>Protocol</Table.Th>
                            <Table.Th>Project</Table.Th>
                            <Table.Th>Env var</Table.Th>
                            <Table.Th>Label</Table.Th>
                            <Table.Th />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {(reservations ?? []).map((r) => (
                            <Table.Tr key={r.id}>
                                <Table.Td>{r.port}</Table.Td>
                                <Table.Td>
                                    <Badge variant="light" color={r.protocol === PortProtocol.UDP ? 'grape' : 'blue'}>
                                        {r.protocol.toUpperCase()}
                                    </Badge>
                                </Table.Td>
                                <Table.Td>{projectName(r.projectId)}</Table.Td>
                                <Table.Td>
                                    <Text span ff="monospace">
                                        {r.envVarName}
                                    </Text>
                                </Table.Td>
                                <Table.Td>{r.label || ''}</Table.Td>
                                <Table.Td>
                                    <Group justify="flex-end">
                                        <Tooltip label="Delete">
                                            <ActionIcon variant="subtle" color="red" onClick={() => remove(r)} disabled={busy}>
                                                <MdOutlineDelete />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                        {reservations && reservations.length === 0 && (
                            <Table.Tr>
                                <Table.Td colSpan={6}>
                                    <Text c="dimmed" fz="sm">
                                        No reserved ports on this node.
                                    </Text>
                                </Table.Td>
                            </Table.Tr>
                        )}
                    </Table.Tbody>
                </Table>

                <Group align="flex-end" wrap="wrap">
                    <NumberInput label="Port" placeholder="25565" min={1} max={65535} allowDecimal={false} value={port} onChange={(v) => setPort(typeof v === 'number' ? v : '')} w={120} />
                    <Select label="Protocol" data={PROTOCOL_OPTIONS} value={protocol} onChange={(v) => setProtocol((v as PortProtocol) || PortProtocol.TCP)} w={110} />
                    <Select label="Project" placeholder="Select project" data={projects.map((p) => ({ value: p.id, label: p.id }))} value={projectId} onChange={setProjectId} searchable flex={1} miw={180} />
                    <TextInput label="Env var" placeholder="MC_JAVA_PORT" value={envVarName} onChange={(e) => setEnvVarName(e.currentTarget.value)} w={180} />
                    <TextInput label="Label (optional)" placeholder="Minecraft Java" value={label} onChange={(e) => setLabel(e.currentTarget.value)} w={180} />
                    <Button onClick={add} loading={busy}>
                        Reserve
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

export default NodePortAllocationCard;
