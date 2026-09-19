import { ActionIcon, Badge, Button, Card, Group, Modal, Select, Stack, Text, Textarea, TextInput, Timeline, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { AddIncidentUpdateBody, Capability, CreateIncidentBody, IncidentImpact, IncidentKind, IncidentStatus, IncidentWithUpdates } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { MdDelete, MdOutlineAdd } from 'react-icons/md';
import { useMe } from '@/contexts/me-context';
import { useAPI } from '@/utils/api';

const INCIDENT_STATUSES: IncidentStatus[] = [IncidentStatus.INVESTIGATING, IncidentStatus.IDENTIFIED, IncidentStatus.MONITORING, IncidentStatus.RESOLVED];
const MAINTENANCE_STATUSES: IncidentStatus[] = [IncidentStatus.SCHEDULED, IncidentStatus.IN_PROGRESS, IncidentStatus.COMPLETED];

const statusLabel = (value: string): string => value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const statusColor = (status: IncidentStatus): string => {
    switch (status) {
        case IncidentStatus.RESOLVED:
        case IncidentStatus.COMPLETED:
            return 'green';
        case IncidentStatus.INVESTIGATING:
            return 'red';
        case IncidentStatus.IDENTIFIED:
            return 'orange';
        case IncidentStatus.MONITORING:
            return 'yellow';
        case IncidentStatus.SCHEDULED:
        case IncidentStatus.IN_PROGRESS:
            return 'blue';
        default:
            return 'gray';
    }
};

const impactColor = (impact: IncidentImpact): string => {
    switch (impact) {
        case IncidentImpact.CRITICAL:
            return 'red';
        case IncidentImpact.MAJOR:
            return 'orange';
        case IncidentImpact.MINOR:
            return 'yellow';
        default:
            return 'gray';
    }
};

const IMPACT_OPTIONS = Object.values(IncidentImpact).map((i) => ({ value: i, label: statusLabel(i) }));

// Convert a datetime-local input value to epoch ms and back.
const toEpoch = (value: string): number | undefined => (value ? new Date(value).getTime() : undefined);
const toInputValue = (ms?: number): string => {
    if (!ms) return '';
    const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
};

interface CreateModalProps {
    projectId: string;
    kind: IncidentKind;
    opened: boolean;
    onClose: () => void;
    onSaved: () => void;
}

const CreateIncidentModal = ({ projectId, kind, opened, onClose, onSaved }: CreateModalProps) => {
    const api = useAPI();
    const isMaintenance = kind === IncidentKind.MAINTENANCE;
    const statuses = isMaintenance ? MAINTENANCE_STATUSES : INCIDENT_STATUSES;
    const [title, setTitle] = useState('');
    const [status, setStatus] = useState<IncidentStatus>(statuses[0]);
    const [impact, setImpact] = useState<IncidentImpact>(isMaintenance ? IncidentImpact.NONE : IncidentImpact.MINOR);
    const [body, setBody] = useState('');
    const [scheduledStart, setScheduledStart] = useState('');
    const [scheduledEnd, setScheduledEnd] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (opened) {
            setTitle('');
            setStatus(statuses[0]);
            setImpact(isMaintenance ? IncidentImpact.NONE : IncidentImpact.MINOR);
            setBody('');
            setScheduledStart('');
            setScheduledEnd('');
        }
    }, [opened]);

    const submit = async () => {
        if (!title.trim()) {
            notifications.show({ message: 'A title is required', color: 'red' });
            return;
        }
        if (isMaintenance && (!scheduledStart || !scheduledEnd)) {
            notifications.show({ message: 'A maintenance window (start and end) is required', color: 'red' });
            return;
        }
        setSaving(true);
        const payload: CreateIncidentBody = {
            kind,
            title: title.trim(),
            status,
            impact,
            body: body.trim() || undefined,
            scheduledStart: isMaintenance ? toEpoch(scheduledStart) : undefined,
            scheduledEnd: isMaintenance ? toEpoch(scheduledEnd) : undefined,
        };
        const res = await api.post(API_ROUTES.POST_CREATE_INCIDENT, { projectId }, payload);
        setSaving(false);
        if (res) {
            notifications.show({ message: isMaintenance ? 'Maintenance scheduled' : 'Incident created', color: 'green' });
            onSaved();
            onClose();
        } else {
            notifications.show({ message: 'Failed to save', color: 'red' });
        }
    };

    return (
        <Modal opened={opened} onClose={onClose} title={isMaintenance ? 'Schedule maintenance' : 'New incident'} size="lg">
            <Stack>
                <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} required />
                <Group grow>
                    <Select label="Status" data={statuses.map((s) => ({ value: s, label: statusLabel(s) }))} value={status} onChange={(v) => v && setStatus(v as IncidentStatus)} />
                    <Select label="Impact" data={IMPACT_OPTIONS} value={impact} onChange={(v) => v && setImpact(v as IncidentImpact)} />
                </Group>
                {isMaintenance && (
                    <Group grow>
                        <TextInput label="Starts" type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.currentTarget.value)} />
                        <TextInput label="Ends" type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.currentTarget.value)} />
                    </Group>
                )}
                <Textarea label="Initial update" placeholder="What's going on?" autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={submit} loading={saving}>
                        {isMaintenance ? 'Schedule' : 'Create'}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

interface UpdateModalProps {
    projectId: string;
    item: IncidentWithUpdates | null;
    onClose: () => void;
    onSaved: () => void;
}

const AddUpdateModal = ({ projectId, item, onClose, onSaved }: UpdateModalProps) => {
    const api = useAPI();
    const isMaintenance = item?.incident.kind === IncidentKind.MAINTENANCE;
    const statuses = isMaintenance ? MAINTENANCE_STATUSES : INCIDENT_STATUSES;
    const [status, setStatus] = useState<IncidentStatus>(statuses[0]);
    const [body, setBody] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (item) {
            setStatus(item.incident.status);
            setBody('');
        }
    }, [item]);

    const submit = async () => {
        if (!item) return;
        if (!body.trim()) {
            notifications.show({ message: 'An update message is required', color: 'red' });
            return;
        }
        setSaving(true);
        const payload: AddIncidentUpdateBody = { status, body: body.trim() };
        const res = await api.post(API_ROUTES.POST_ADD_INCIDENT_UPDATE, { projectId, incidentId: item.incident.id }, payload);
        setSaving(false);
        if (res) {
            notifications.show({ message: 'Update posted', color: 'green' });
            onSaved();
            onClose();
        } else {
            notifications.show({ message: 'Failed to post update', color: 'red' });
        }
    };

    return (
        <Modal opened={!!item} onClose={onClose} title={`Post update: ${item?.incident.title ?? ''}`} size="lg">
            <Stack>
                <Select label="Status" data={statuses.map((s) => ({ value: s, label: statusLabel(s) }))} value={status} onChange={(v) => v && setStatus(v as IncidentStatus)} />
                <Textarea label="Update" autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={submit} loading={saving}>
                        Post update
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

const IncidentCard = ({ item, canManage, onUpdate, onDelete }: { item: IncidentWithUpdates; canManage: boolean; onUpdate: () => void; onDelete: () => void }) => {
    const { incident, updates } = item;
    const isMaintenance = incident.kind === IncidentKind.MAINTENANCE;
    return (
        <Card withBorder>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap="xs">
                        <Badge variant="light" color={isMaintenance ? 'blue' : 'grape'}>
                            {isMaintenance ? 'Maintenance' : 'Incident'}
                        </Badge>
                        <Badge color={statusColor(incident.status)}>{statusLabel(incident.status)}</Badge>
                        <Badge variant="outline" color={impactColor(incident.impact)}>
                            {statusLabel(incident.impact)} impact
                        </Badge>
                    </Group>
                    <Title order={5}>{incident.title}</Title>
                    <Text size="xs" c="dimmed">
                        {isMaintenance && incident.scheduledStart
                            ? `Scheduled ${new Date(incident.scheduledStart).toLocaleString()} → ${incident.scheduledEnd ? new Date(incident.scheduledEnd).toLocaleString() : '?'}`
                            : `Started ${new Date(incident.startedAt).toLocaleString()}`}
                        {incident.resolvedAt ? ` · Resolved ${new Date(incident.resolvedAt).toLocaleString()}` : ''}
                    </Text>
                </Stack>
                {canManage && (
                    <Group gap="xs" wrap="nowrap">
                        <Button size="xs" variant="light" leftSection={<MdOutlineAdd />} onClick={onUpdate}>
                            Post update
                        </Button>
                        <Tooltip label="Delete">
                            <ActionIcon color="red" variant="light" onClick={onDelete}>
                                <MdDelete />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                )}
            </Group>
            {updates.length > 0 && (
                <Timeline active={-1} bulletSize={14} lineWidth={2} mt="md">
                    {updates.map((u) => (
                        <Timeline.Item key={u.id} title={statusLabel(u.status)}>
                            <Text size="sm">{u.body}</Text>
                            <Text size="xs" c="dimmed">
                                {u.createdBy} · {new Date(u.createdAt).toLocaleString()}
                            </Text>
                        </Timeline.Item>
                    ))}
                </Timeline>
            )}
        </Card>
    );
};

export const IncidentSection = ({ projectId }: { projectId: string }) => {
    const api = useAPI();
    const meCtx = useMe();
    const canManage = meCtx.canProject(projectId, Capability.MANAGE_INCIDENTS);

    const [items, setItems] = useState<IncidentWithUpdates[]>([]);
    const [createKind, setCreateKind] = useState<IncidentKind | null>(null);
    const [updateTarget, setUpdateTarget] = useState<IncidentWithUpdates | null>(null);
    const [incidentModal, incidentModalCtl] = useDisclosure(false);

    const load = () => {
        if (!api.token) return;
        api.get(API_ROUTES.GET_PROJECT_INCIDENTS, { projectId }).then((res) => setItems(res ?? []));
    };

    useEffect(() => {
        load();
    }, [projectId, api.token]);

    const openCreate = (kind: IncidentKind) => {
        setCreateKind(kind);
        incidentModalCtl.open();
    };

    const remove = async (item: IncidentWithUpdates) => {
        if (!window.confirm(`Delete "${item.incident.title}"? This cannot be undone.`)) return;
        await api.post(API_ROUTES.POST_DELETE_INCIDENT, { projectId, incidentId: item.incident.id }, {});
        notifications.show({ message: 'Incident deleted', color: 'green' });
        load();
    };

    return (
        <Card withBorder>
            <Group justify="space-between" align="center" mb="sm">
                <Title order={4}>Incidents & maintenance</Title>
                {canManage && (
                    <Group gap="xs">
                        <Button size="xs" variant="light" onClick={() => openCreate(IncidentKind.INCIDENT)}>
                            New incident
                        </Button>
                        <Button size="xs" variant="light" color="blue" onClick={() => openCreate(IncidentKind.MAINTENANCE)}>
                            Schedule maintenance
                        </Button>
                    </Group>
                )}
            </Group>

            {items.length === 0 ? (
                <Text c="dimmed" size="sm">
                    No incidents or scheduled maintenance.
                </Text>
            ) : (
                <Stack>
                    {items.map((item) => (
                        <IncidentCard key={item.incident.id} item={item} canManage={canManage} onUpdate={() => setUpdateTarget(item)} onDelete={() => remove(item)} />
                    ))}
                </Stack>
            )}

            {createKind && (
                <CreateIncidentModal
                    projectId={projectId}
                    kind={createKind}
                    opened={incidentModal}
                    onClose={() => {
                        incidentModalCtl.close();
                        setCreateKind(null);
                    }}
                    onSaved={load}
                />
            )}
            <AddUpdateModal projectId={projectId} item={updateTarget} onClose={() => setUpdateTarget(null)} onSaved={load} />
        </Card>
    );
};
