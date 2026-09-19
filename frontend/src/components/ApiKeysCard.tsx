import { ActionIcon, Alert, Badge, Button, Card, Checkbox, CopyButton, Group, Modal, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ApiKeyPermission, ApiKeyView, CreateApiKeyResult } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdContentCopy, MdDelete, MdDone } from 'react-icons/md';
import { useProjectApiKeys } from '@/hooks/queries/projectHooks';
import { useCreateApiKey, useRevokeApiKey } from '@/hooks/mutations/projectResourceMutations';

// Label for each API key permission. Only GET_STATUS exists today.
const PERMISSION_LABELS: { value: ApiKeyPermission; label: string; description: string }[] = [{ value: ApiKeyPermission.GET_STATUS, label: 'Get status', description: 'Read current status, uptime and recent incidents' }];

const permissionLabel = (p: ApiKeyPermission): string => PERMISSION_LABELS.find((x) => x.value === p)?.label ?? p;

export const ApiKeysCard = ({ projectId }: { projectId: string }) => {
    const { data: keys = [] } = useProjectApiKeys(projectId);
    const createKey = useCreateApiKey(projectId);
    const revokeKey = useRevokeApiKey(projectId);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState('');
    const [permissions, setPermissions] = useState<ApiKeyPermission[]>([ApiKeyPermission.GET_STATUS]);
    const [created, setCreated] = useState<CreateApiKeyResult | null>(null);
    const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyView | null>(null);

    const saving = createKey.isPending;
    const revoking = revokeKey.isPending;

    const openCreate = () => {
        setName('');
        setPermissions([ApiKeyPermission.GET_STATUS]);
        setCreateOpen(true);
    };

    const submitCreate = async () => {
        if (!name.trim()) {
            notifications.show({ message: 'A name is required', color: 'red' });
            return;
        }
        if (permissions.length === 0) {
            notifications.show({ message: 'Select at least one permission', color: 'red' });
            return;
        }
        const res = await createKey.mutateAsync({ name: name.trim(), permissions });
        if (res) {
            setCreateOpen(false);
            setCreated(res);
        } else {
            notifications.show({ message: 'Failed to create API key', color: 'red' });
        }
    };

    const confirmRevoke = async () => {
        if (!keyToRevoke) return;
        await revokeKey.mutateAsync(keyToRevoke.id);
        notifications.show({ message: 'API key revoked', color: 'green' });
        setKeyToRevoke(null);
    };

    const togglePermission = (p: ApiKeyPermission, checked: boolean) => {
        setPermissions((prev) => (checked ? [...new Set([...prev, p])] : prev.filter((x) => x !== p)));
    };

    return (
        <Card withBorder>
            <Group justify="space-between" align="center" mb="sm">
                <Stack gap={0}>
                    <Title order={5}>API Keys</Title>
                    <Text size="xs" c="dimmed">
                        Grant external services scoped, read-only access to this project (e.g. a status page). Query <code>GET /api/v1/status</code> with the key.
                    </Text>
                </Stack>
                <Button size="xs" variant="light" onClick={openCreate}>
                    Create API key
                </Button>
            </Group>

            {keys.length === 0 ? (
                <Text c="dimmed" size="sm">
                    No API keys yet.
                </Text>
            ) : (
                <Table>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Name</Table.Th>
                            <Table.Th>Key</Table.Th>
                            <Table.Th>Permissions</Table.Th>
                            <Table.Th>Last used</Table.Th>
                            <Table.Th />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {keys.map((key) => (
                            <Table.Tr key={key.id}>
                                <Table.Td>
                                    <Text size="sm" fw={500}>
                                        {key.name}
                                    </Text>
                                    {key.revokedAt && (
                                        <Badge size="xs" color="red" variant="light">
                                            Revoked
                                        </Badge>
                                    )}
                                </Table.Td>
                                <Table.Td>
                                    <Text size="sm" ff="monospace" c="dimmed">
                                        nsm_{key.prefix}_…
                                    </Text>
                                </Table.Td>
                                <Table.Td>
                                    <Group gap={4}>
                                        {key.permissions.map((p) => (
                                            <Badge key={p} size="xs" variant="light">
                                                {permissionLabel(p)}
                                            </Badge>
                                        ))}
                                    </Group>
                                </Table.Td>
                                <Table.Td>
                                    <Text size="xs" c="dimmed">
                                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
                                    </Text>
                                </Table.Td>
                                <Table.Td>
                                    {!key.revokedAt && (
                                        <Tooltip label="Revoke">
                                            <ActionIcon color="red" variant="light" onClick={() => setKeyToRevoke(key)}>
                                                <MdDelete />
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}

            <Modal opened={!!keyToRevoke} onClose={() => setKeyToRevoke(null)} title="Revoke API key">
                <Stack>
                    <Text size="sm">Revoke &quot;{keyToRevoke?.name}&quot;? Any integrations using it will stop working.</Text>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setKeyToRevoke(null)} disabled={revoking}>
                            Cancel
                        </Button>
                        <Button color="red" onClick={confirmRevoke} loading={revoking}>
                            Revoke
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create API key">
                <Stack>
                    <TextInput label="Name" placeholder="Status page" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>
                            Permissions
                        </Text>
                        {PERMISSION_LABELS.map((p) => (
                            <Checkbox key={p.value} label={p.label} description={p.description} checked={permissions.includes(p.value)} onChange={(e) => togglePermission(p.value, e.currentTarget.checked)} />
                        ))}
                    </Stack>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setCreateOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submitCreate} loading={saving}>
                            Create
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={!!created} onClose={() => setCreated(null)} title="API key created" size="lg">
                <Stack>
                    <Alert color="yellow" variant="light" title="Copy this key now">
                        This is the only time the full key will be shown. Store it somewhere safe.
                    </Alert>
                    <Group align="flex-end" wrap="nowrap">
                        <TextInput flex={1} label="API key" readOnly value={created?.secret ?? ''} ff="monospace" />
                        <CopyButton value={created?.secret ?? ''}>
                            {({ copied, copy }) => (
                                <Tooltip label={copied ? 'Copied' : 'Copy'}>
                                    <ActionIcon size="lg" variant="light" color={copied ? 'green' : 'blue'} onClick={copy}>
                                        {copied ? <MdDone /> : <MdContentCopy />}
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </CopyButton>
                    </Group>
                    <Group justify="flex-end">
                        <Button onClick={() => setCreated(null)}>Done</Button>
                    </Group>
                </Stack>
            </Modal>
        </Card>
    );
};
