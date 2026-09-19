import { ActionIcon, Anchor, Badge, Button, Card, Checkbox, Collapse, Group, Modal, Radio, Stack, Switch, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { ALL_GITHUB_SCENARIOS, GITHUB_SCENARIO_SUBEVENTS, GithubScenario, GithubScenarioConfig, GithubScenarioLifecycle, ProjectEventType, ProjectWebhook } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdDelete, MdEdit, MdSend } from 'react-icons/md';
import { queryKeys } from '@/query/keys';
import { useProjectWebhooks } from '@/hooks/queries/projectHooks';
import { useCreateWebhook, useUpdateWebhook, useDeleteWebhook, useTestWebhook } from '@/hooks/mutations/projectResourceMutations';

// Subscribable NSM events, grouped for the picker. Labels are UI-only; the values are the stable wire ids.
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

// User-facing labels for each GitHub scenario and its sub-events.
const SCENARIO_LABELS: Record<GithubScenario, string> = {
    [GithubScenario.PULL_REQUEST]: 'Pull Requests',
    [GithubScenario.ISSUE]: 'Issues',
    [GithubScenario.RELEASE]: 'Releases',
    [GithubScenario.PUSH]: 'Pushes',
    [GithubScenario.WORKFLOW_RUN]: 'GitHub Actions',
};

const SUBEVENT_LABELS: Record<string, string> = {
    opened: 'Opened',
    approved: 'Approved',
    changes_requested: 'Changes requested',
    merged: 'Merged',
    closed: 'Closed',
    published: 'Published',
    pushed: 'Pushed',
    failed: 'Failed',
    succeeded: 'Succeeded',
};

const LIFECYCLE_OPTIONS: { value: GithubScenarioLifecycle; label: string; help: string }[] = [
    { value: 'new', label: 'New message each time', help: 'Every event posts a fresh message.' },
    { value: 'update', label: 'Update one message', help: 'The first event posts; later ones edit that message in place.' },
    { value: 'update_then_delete', label: 'Update, then delete when closed', help: 'Edits in place, then removes the message when the subject is merged/closed.' },
];

// Scenarios where a branch filter is meaningful (others fire regardless of branch).
const BRANCH_FILTERABLE = new Set<GithubScenario>([GithubScenario.PULL_REQUEST, GithubScenario.PUSH, GithubScenario.WORKFLOW_RUN]);

export const WebhooksSection = ({ projectId, githubAppInstalled }: { projectId: string; githubAppInstalled: boolean }) => {
    const queryClient = useQueryClient();
    const { data: webhooks = [] } = useProjectWebhooks(projectId);
    const createWebhook = useCreateWebhook(projectId);
    const updateWebhook = useUpdateWebhook(projectId);
    const deleteWebhook = useDeleteWebhook(projectId);
    const testWebhook = useTestWebhook(projectId);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<ProjectWebhook | null>(null);
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [events, setEvents] = useState<ProjectEventType[]>([]);
    const [scenarios, setScenarios] = useState<GithubScenarioConfig[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [testingId, setTestingId] = useState<string | null>(null);

    const saving = createWebhook.isPending || updateWebhook.isPending;

    const openCreate = () => {
        setEditing(null);
        setName('');
        setUrl('');
        setEvents([ProjectEventType.DEPLOY_SUCCEEDED, ProjectEventType.DEPLOY_FAILED]);
        setScenarios([]);
        setEnabled(true);
        setModalOpen(true);
    };

    const openEdit = (webhook: ProjectWebhook) => {
        setEditing(webhook);
        setName(webhook.name);
        // The stored URL is returned masked; leaving it as-is keeps the existing secret on save.
        setUrl(webhook.url);
        setEvents(webhook.events);
        setScenarios(webhook.githubScenarios ?? []);
        setEnabled(webhook.enabled);
        setModalOpen(true);
    };

    const toggleEvent = (value: ProjectEventType, checked: boolean) => {
        setEvents((prev) => (checked ? [...new Set([...prev, value])] : prev.filter((e) => e !== value)));
    };

    // === GitHub scenario editing helpers ===
    const scenarioConfig = (scenario: GithubScenario): GithubScenarioConfig | undefined => scenarios.find((s) => s.scenario === scenario);

    const setScenarioEnabled = (scenario: GithubScenario, on: boolean) => {
        setScenarios((prev) => {
            if (!on) return prev.filter((s) => s.scenario !== scenario);
            if (prev.some((s) => s.scenario === scenario)) return prev;
            // Sensible default: notify on all sub-events; PRs get the rich update-then-delete lifecycle.
            const lifecycle: GithubScenarioLifecycle = scenario === GithubScenario.PULL_REQUEST ? 'update_then_delete' : 'new';
            return [...prev, { scenario, on: [...GITHUB_SCENARIO_SUBEVENTS[scenario]], lifecycle }];
        });
    };

    const patchScenario = (scenario: GithubScenario, patch: Partial<GithubScenarioConfig>) => {
        setScenarios((prev) => prev.map((s) => (s.scenario === scenario ? { ...s, ...patch } : s)));
    };

    const toggleSubEvent = (scenario: GithubScenario, sub: string, checked: boolean) => {
        const cfg = scenarioConfig(scenario);
        if (!cfg) return;
        const on = checked ? [...new Set([...cfg.on, sub])] : cfg.on.filter((e) => e !== sub);
        patchScenario(scenario, { on });
    };

    const submit = async () => {
        if (!name.trim()) {
            notifications.show({ message: 'A name is required', color: 'red' });
            return;
        }
        // Drop enabled scenarios that ended up with no sub-events selected.
        const cleanScenarios = scenarios.filter((s) => s.on.length > 0);
        if (events.length === 0 && cleanScenarios.length === 0) {
            notifications.show({ message: 'Select at least one event or GitHub scenario', color: 'red' });
            return;
        }
        try {
            if (editing) {
                await updateWebhook.mutateAsync({ webhookId: editing.id, body: { name: name.trim(), url, events, githubScenarios: cleanScenarios, enabled } });
            } else {
                await createWebhook.mutateAsync({ name: name.trim(), url, events, githubScenarios: cleanScenarios, enabled });
            }
            setModalOpen(false);
            notifications.show({ message: editing ? 'Webhook updated' : 'Webhook created', color: 'green' });
        } catch {
            notifications.show({ message: `Failed to ${editing ? 'update' : 'create'} webhook`, color: 'red' });
        }
    };

    const remove = async (webhook: ProjectWebhook) => {
        if (!window.confirm(`Delete "${webhook.name}"? It will stop receiving events.`)) return;
        await deleteWebhook.mutateAsync(webhook.id);
        notifications.show({ message: 'Webhook deleted', color: 'green' });
    };

    const toggleEnabled = async (webhook: ProjectWebhook, next: boolean) => {
        // Optimistic flip; the masked url is echoed back so the stored secret is left unchanged.
        queryClient.setQueryData<ProjectWebhook[]>(queryKeys.projectWebhooks(projectId), (prev) => (prev ?? []).map((w) => (w.id === webhook.id ? { ...w, enabled: next } : w)));
        await updateWebhook.mutateAsync({ webhookId: webhook.id, body: { enabled: next } });
    };

    const test = async (webhook: ProjectWebhook) => {
        setTestingId(webhook.id);
        try {
            const res = await testWebhook.mutateAsync(webhook.id);
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

    const subscriptionSummary = (webhook: ProjectWebhook): string => {
        const parts: string[] = [];
        if (webhook.events.length) parts.push(`${webhook.events.length} event${webhook.events.length === 1 ? '' : 's'}`);
        const sc = webhook.githubScenarios?.length ?? 0;
        if (sc) parts.push(`${sc} GitHub`);
        return parts.length ? parts.join(' + ') : 'none';
    };

    return (
        <Card withBorder>
            <Group justify="space-between" align="center" mb="sm">
                <Stack gap={0}>
                    <Title order={5}>Webhooks</Title>
                    <Text size="xs" c="dimmed">
                        Send Discord messages when things happen on this project — NSM events (deploys, incidents, health, resource usage) and rich GitHub notifications (pull requests, issues, releases, pushes, Actions). Paste a Discord channel&apos;s webhook URL and choose what fires it.
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
                            <Table.Th>Subscriptions</Table.Th>
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
                                        {subscriptionSummary(webhook)}
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
                            NSM events
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

                    <Stack gap={4}>
                        <Text size="sm" fw={500}>
                            GitHub notifications
                        </Text>
                        {!githubAppInstalled ? (
                            <Text size="xs" c="dimmed">
                                Install the NSM GitHub App on this project&apos;s team to receive GitHub notifications.
                            </Text>
                        ) : (
                            <Stack gap={6}>
                                {ALL_GITHUB_SCENARIOS.map((scenario) => {
                                    const cfg = scenarioConfig(scenario);
                                    const on = !!cfg;
                                    return (
                                        <Card key={scenario} withBorder padding="xs">
                                            <Group justify="space-between">
                                                <Text size="sm" fw={500}>
                                                    {SCENARIO_LABELS[scenario]}
                                                </Text>
                                                <Switch checked={on} onChange={(e) => setScenarioEnabled(scenario, e.currentTarget.checked)} />
                                            </Group>
                                            <Collapse in={on}>
                                                {cfg && (
                                                    <Stack gap="xs" mt="xs">
                                                        <Stack gap={2}>
                                                            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                                                                Notify on
                                                            </Text>
                                                            <Group gap="md">
                                                                {GITHUB_SCENARIO_SUBEVENTS[scenario].map((sub) => (
                                                                    <Checkbox key={sub} size="xs" label={SUBEVENT_LABELS[sub] ?? sub} checked={cfg.on.includes(sub)} onChange={(e) => toggleSubEvent(scenario, sub, e.currentTarget.checked)} />
                                                                ))}
                                                            </Group>
                                                        </Stack>
                                                        <Radio.Group
                                                            label="Message behavior"
                                                            value={cfg.lifecycle}
                                                            onChange={(v) => patchScenario(scenario, { lifecycle: v as GithubScenarioLifecycle })}
                                                        >
                                                            <Stack gap={2} mt={4}>
                                                                {LIFECYCLE_OPTIONS.map((opt) => (
                                                                    <Radio key={opt.value} size="xs" value={opt.value} label={opt.label} description={opt.help} />
                                                                ))}
                                                            </Stack>
                                                        </Radio.Group>
                                                        {BRANCH_FILTERABLE.has(scenario) && (
                                                            <TextInput
                                                                size="xs"
                                                                label="Branch filter (optional)"
                                                                placeholder="main, release/*"
                                                                description="Comma-separated branches. Leave blank for all branches."
                                                                value={(cfg.branches ?? []).join(', ')}
                                                                onChange={(e) => {
                                                                    const branches = e.currentTarget.value
                                                                        .split(',')
                                                                        .map((b) => b.trim())
                                                                        .filter(Boolean);
                                                                    patchScenario(scenario, { branches: branches.length ? branches : undefined });
                                                                }}
                                                            />
                                                        )}
                                                    </Stack>
                                                )}
                                            </Collapse>
                                        </Card>
                                    );
                                })}
                            </Stack>
                        )}
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
