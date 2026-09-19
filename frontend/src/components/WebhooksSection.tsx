import { ActionIcon, Anchor, Badge, Button, Card, Checkbox, Group, Modal, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { ProjectEventType, ProjectWebhook, ProjectWebhookType } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { MdDelete, MdEdit, MdSend } from 'react-icons/md';
import { useAPI } from '@/utils/api';

// Subscribable events, grouped for the picker. Labels are UI-only; the values are the stable wire ids.
const EVENT_GROUPS: { group: string; events: { value: ProjectEventType; label: string }[] }[] = [
    {
        group: 'Deployments',
        events: [
            { value: ProjectEventType.DEPLOY_STARTED, label: 'Deploy started' },
            { value: ProjectEventType.DEPLOY_SUCCEEDED, label: 'Deploy succeeded' },
            { value: ProjectEventType.DEPLOY_FAILED, label: 'Deploy failed' },
            { value: ProjectEventType.DEPLOY_CANCELLED, label: 'Deploy cancelled' },
        ],
    },
    {
        group: 'Incidents',
        events: [
            { value: ProjectEventType.INCIDENT_CREATED, label: 'Incident opened' },
            { value: ProjectEventType.INCIDENT_UPDATED, label: 'Incident updated' },
            { value: ProjectEventType.INCIDENT_RESOLVED, label: 'Incident resolved' },
        ],
    },
    {
        group: 'Health',
        events: [
            { value: ProjectEventType.HEALTH_DEGRADED, label: 'Health degraded' },
            { value: ProjectEventType.HEALTH_DOWN, label: 'Health down' },
            { value: ProjectEventType.HEALTH_RECOVERED, label: 'Health recovered' },
        ],
    },
    {
        group: 'Resources',
        events: [{ value: ProjectEventType.QUOTA_BREACHED, label: 'Over resource allocation' }],
    },
];

export const WebhooksSection = ({ projectId }: { projectId: string }) => {
    const api = useAPI();
    const [webhooks, setWebhooks] = useState<ProjectWebhook[]>([]);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<ProjectWebhook | null>(null);
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [events, setEvents] = useState<ProjectEventType[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testingId, setTestingId] = useState<string | null>(null);

    const load = () => {
        if (!api.token) return;
        api.get(API_ROUTES.GET_PROJECT_WEBHOOKS, { projectId }).then((res) => setWebhooks(res ?? []));
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, api.token]);

    const openCreate = () => {
        setEditing(null);
        setName('');
        setUrl('');
        setEvents([ProjectEventType.DEPLOY_SUCCEEDED, ProjectEventType.DEPLOY_FAILED]);
        setEnabled(true);
        setModalOpen(true);
    };

    const openEdit = (webhook: ProjectWebhook) => {
        setEditing(webhook);
        setName(webhook.name);
        // The stored URL is returned masked; leaving it as-is keeps the existing secret on save.
        setUrl(webhook.url);
        setEvents(webhook.events);
        setEnabled(webhook.enabled);
        setModalOpen(true);
    };

    const toggleEvent = (value: ProjectEventType, checked: boolean) => {
        setEvents((prev) => (checked ? [...new Set([...prev, value])] : prev.filter((e) => e !== value)));
    };

    const submit = async () => {
        if (!name.trim()) {
            notifications.show({ message: 'A name is required', color: 'red' });
            return;
        }
        if (events.length === 0) {
            notifications.show({ message: 'Select at least one event', color: 'red' });
            return;
        }
        setSaving(true);
        try {
            if (editing) {
                const res = await api.post(API_ROUTES.POST_UPDATE_PROJECT_WEBHOOK, { projectId, webhookId: editing.id }, { name: name.trim(), url, events, enabled });
                if (!res) throw new Error();
            } else {
                const res = await api.post(API_ROUTES.POST_CREATE_PROJECT_WEBHOOK, { projectId }, { type: ProjectWebhookType.DISCORD, name: name.trim(), url, events, enabled });
                if (!res) throw new Error();
            }
            setModalOpen(false);
            notifications.show({ message: editing ? 'Webhook updated' : 'Webhook created', color: 'green' });
            load();
        } catch {
            notifications.show({ message: `Failed to ${editing ? 'update' : 'create'} webhook`, color: 'red' });
        } finally {
            setSaving(false);
        }
    };

    const remove = async (webhook: ProjectWebhook) => {
        if (!window.confirm(`Delete "${webhook.name}"? It will stop receiving events.`)) return;
        await api.post(API_ROUTES.POST_DELETE_PROJECT_WEBHOOK, { projectId, webhookId: webhook.id }, {});
        notifications.show({ message: 'Webhook deleted', color: 'green' });
        load();
    };

    const toggleEnabled = async (webhook: ProjectWebhook, next: boolean) => {
        // Optimistic flip; the masked url is echoed back so the stored secret is left unchanged.
        setWebhooks((prev) => prev.map((w) => (w.id === webhook.id ? { ...w, enabled: next } : w)));
        await api.post(API_ROUTES.POST_UPDATE_PROJECT_WEBHOOK, { projectId, webhookId: webhook.id }, { enabled: next });
        load();
    };

    const test = async (webhook: ProjectWebhook) => {
        setTestingId(webhook.id);
        try {
            const res = await api.post(API_ROUTES.POST_TEST_PROJECT_WEBHOOK, { projectId, webhookId: webhook.id }, {});
            if (res?.ok) {
                notifications.show({ message: 'Test message sent', color: 'green' });
            } else {
                notifications.show({ message: 'Test delivery failed. Check the webhook URL.', color: 'red' });
            }
        } catch {
            notifications.show({ message: 'Test delivery failed', color: 'red' });
        } finally {
            setTestingId(null);
        }
    };

    return (
        <Card withBorder>
            <Group justify="space-between" align="center" mb="sm">
                <Stack gap={0}>
                    <Title order={5}>Webhooks</Title>
                    <Text size="xs" c="dimmed">
                        Send a Discord message when things happen on this project (deploys, incidents, health changes, resource usage). Paste a Discord channel&apos;s webhook URL and choose which events fire it.
                    </Text>
                </Stack>
                <Button size="xs" variant="light" onClick={openCreate}>
                    Add webhook
                </Button>
            </Group>

            {webhooks.length === 0 ? (
                <Text c="dimmed" size="sm">
                    No webhooks yet.
                </Text>
            ) : (
                <Table>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>Name</Table.Th>
                            <Table.Th>Type</Table.Th>
                            <Table.Th>Events</Table.Th>
                            <Table.Th>Enabled</Table.Th>
                            <Table.Th />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {webhooks.map((webhook) => (
                            <Table.Tr key={webhook.id}>
                                <Table.Td>
                                    <Text size="sm" fw={500}>
                                        {webhook.name}
                                    </Text>
                                    <Text size="xs" ff="monospace" c="dimmed">
                                        {webhook.url}
                                    </Text>
                                </Table.Td>
                                <Table.Td>
                                    <Badge size="xs" variant="light">
                                        Discord
                                    </Badge>
                                </Table.Td>
                                <Table.Td>
                                    <Badge size="xs" variant="light" color="gray">
                                        {webhook.events.length} event{webhook.events.length === 1 ? '' : 's'}
                                    </Badge>
                                </Table.Td>
                                <Table.Td>
                                    <Switch checked={webhook.enabled} onChange={(e) => toggleEnabled(webhook, e.currentTarget.checked)} />
                                </Table.Td>
                                <Table.Td>
                                    <Group gap={4} justify="flex-end" wrap="nowrap">
                                        <Tooltip label="Send test message">
                                            <ActionIcon variant="light" loading={testingId === webhook.id} onClick={() => test(webhook)}>
                                                <MdSend />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label="Edit">
                                            <ActionIcon variant="light" onClick={() => openEdit(webhook)}>
                                                <MdEdit />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label="Delete">
                                            <ActionIcon color="red" variant="light" onClick={() => remove(webhook)}>
                                                <MdDelete />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Group>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}

            <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit webhook' : 'Add Discord webhook'} size="lg">
                <Stack>
                    <TextInput label="Name" placeholder="Team channel" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
                    <TextInput
                        label="Discord webhook URL"
                        placeholder="https://discord.com/api/webhooks/..."
                        value={url}
                        onChange={(e) => setUrl(e.currentTarget.value)}
                        required={!editing}
                        description={
                            <Text size="xs" c="dimmed">
                                In Discord: Channel settings &rarr; Integrations &rarr; Webhooks &rarr; New Webhook &rarr; Copy Webhook URL.{' '}
                                <Anchor href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks" target="_blank" rel="noopener noreferrer" size="xs">
                                    Learn more
                                </Anchor>
                                {editing ? '. Leave unchanged to keep the current URL.' : ''}
                            </Text>
                        }
                    />
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>
                            Events
                        </Text>
                        {EVENT_GROUPS.map((grp) => (
                            <Stack key={grp.group} gap={2} mb={4}>
                                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                                    {grp.group}
                                </Text>
                                {grp.events.map((ev) => (
                                    <Checkbox key={ev.value} label={ev.label} checked={events.includes(ev.value)} onChange={(e) => toggleEvent(ev.value, e.currentTarget.checked)} />
                                ))}
                            </Stack>
                        ))}
                    </Stack>
                    <Switch label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} loading={saving}>
                            {editing ? 'Save' : 'Add webhook'}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Card>
    );
};
