import { ActionIcon, Alert, Badge, Button, Divider, Fieldset, Group, Modal, MultiSelect, NumberInput, Select, Stack, Switch, Table, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DnsRecord, DnsRecordType, DNS_RECORD_TYPES, DNS_STRUCTURED_TYPES, DnsZone, PortReservation, Project, Team } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useEffect, useState } from 'react';
import { useAPI } from '@/utils/api';
import { MdOutlineDelete, MdOutlineEdit } from 'react-icons/md';

interface DomainDetailModalProps {
    zone: DnsZone;
    teams: Team[];
    projects: Project[];
    isAdmin: boolean;
    isSuperAdmin: boolean;
    publicIp: string | null;
    onClose: () => void;
    onChanged: () => void;
}

const PROXYABLE = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME']);
const DYNAMIC_CAPABLE = new Set<DnsRecordType>(['A', 'AAAA']);
const PRIORITY_TYPES = new Set<DnsRecordType>(['MX', 'SRV', 'URI']);
// Record types whose port NSM can drive from a reservation (SRV's port lives in data.port).
const PORT_BINDABLE = new Set<DnsRecordType>(['SRV']);

type Draft = Partial<DnsRecord>;

const emptyDraft = (): Draft => ({ type: 'A', name: '', content: '', ttl: 1, proxied: false, dynamic: false });

export const DomainDetailModal = (props: DomainDetailModalProps) => {
    const api = useAPI();
    const { zone } = props;
    const [records, setRecords] = useState<DnsRecord[] | null>(null);
    const [reservations, setReservations] = useState<PortReservation[]>([]);
    const [editing, setEditing] = useState<null | 'new' | string>(null);
    const [draft, setDraft] = useState<Draft>(emptyDraft());
    const [dataJson, setDataJson] = useState('');
    const [busy, setBusy] = useState(false);

    const [allocations, setAllocations] = useState<string[]>(zone.allocatedTeamIds ?? []);
    const [assigned, setAssigned] = useState<string | null>(zone.assignedProjectId ?? null);
    const [confirmName, setConfirmName] = useState('');

    const loadRecords = async () => {
        if (!props.isAdmin) return;
        const res = await api.get(API_ROUTES.GET_DNS_RECORDS, { zoneId: zone.id });
        setRecords(res ?? []);
    };

    useEffect(() => {
        void loadRecords();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [zone.id]);

    useEffect(() => {
        if (!props.isAdmin) return;
        void api.get(API_ROUTES.GET_PORT_RESERVATIONS, {}).then((res) => setReservations(res ?? []));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.isAdmin]);

    const startNew = () => {
        setDraft(emptyDraft());
        setDataJson('');
        setEditing('new');
    };
    const startEdit = (r: DnsRecord) => {
        setDraft({ ...r });
        setDataJson(r.data ? JSON.stringify(r.data, null, 2) : '');
        setEditing(r.id);
    };

    const saveRecord = async () => {
        if (!draft.type || !draft.name) {
            notifications.show({ color: 'red', message: 'Type and name are required.' });
            return;
        }
        const body: Draft = { ...draft };
        if (DNS_STRUCTURED_TYPES.includes(draft.type)) {
            if (dataJson.trim()) {
                try {
                    body.data = JSON.parse(dataJson);
                } catch {
                    notifications.show({ color: 'red', message: 'Record data must be valid JSON.' });
                    return;
                }
            }
        }
        setBusy(true);
        try {
            const res = editing === 'new' ? await api.post(API_ROUTES.POST_DNS_RECORD_CREATE, { zoneId: zone.id }, body) : await api.post(API_ROUTES.POST_DNS_RECORD_UPDATE, { zoneId: zone.id, recordId: editing as string }, body);
            if (res === undefined) throw new Error('Request failed');
            notifications.show({ color: 'green', message: `Record ${editing === 'new' ? 'created' : 'updated'}.` });
            setEditing(null);
            await loadRecords();
            props.onChanged();
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Failed to save record.' });
        } finally {
            setBusy(false);
        }
    };

    const deleteRecord = async (r: DnsRecord) => {
        if (!window.confirm(`Delete ${r.type} record ${r.name}?`)) return;
        setBusy(true);
        try {
            await api.post(API_ROUTES.POST_DNS_RECORD_DELETE, { zoneId: zone.id, recordId: r.id }, {});
            await loadRecords();
            props.onChanged();
        } finally {
            setBusy(false);
        }
    };

    const saveAllocations = async () => {
        setBusy(true);
        try {
            const res = await api.post(API_ROUTES.POST_DOMAIN_ALLOCATIONS, { zoneId: zone.id }, { ownerIds: allocations });
            if (res && res.ok === false) {
                const list = (res.blockedBy || []).map((b) => `${b.projectId} (${b.ownerLogin})`).join(', ');
                notifications.show({ color: 'red', title: 'Domain in use', message: `Cannot remove a team while these projects use the domain: ${list}` });
                setAllocations(zone.allocatedTeamIds ?? []);
                return;
            }
            notifications.show({ color: 'green', message: 'Team allocations updated.' });
            props.onChanged();
        } finally {
            setBusy(false);
        }
    };

    const saveAssignment = async () => {
        setBusy(true);
        try {
            await api.post(API_ROUTES.POST_DOMAIN_ASSIGN, { zoneId: zone.id }, { projectId: assigned });
            notifications.show({ color: 'green', message: 'Project assignment updated.' });
            props.onChanged();
        } finally {
            setBusy(false);
        }
    };

    const doDelete = async () => {
        setBusy(true);
        try {
            await api.post(API_ROUTES.POST_DOMAIN_DELETE, { zoneId: zone.id }, { confirmName });
            notifications.show({ color: 'green', message: `${zone.name} deleted from Cloudflare.` });
            props.onChanged();
            props.onClose();
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Delete failed.' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal opened onClose={props.onClose} size="xl" title={<Title order={4}>{zone.name}</Title>}>
            <Stack>
                <Group gap="xs">
                    <Badge color={zone.status === 'active' ? 'green' : 'yellow'} variant="light">
                        {zone.status}
                    </Badge>
                    {zone.paused && <Badge color="orange">paused</Badge>}
                    {zone.billing?.registrationStatus && <Badge variant="outline">{zone.billing.registrationStatus}</Badge>}
                    {zone.billing?.autoRenew !== undefined && <Badge variant="outline">auto-renew {zone.billing.autoRenew ? 'on' : 'off'}</Badge>}
                </Group>
                <Group gap="xl">
                    {zone.billing?.expiresAt && (
                        <Text fz="sm" c="dimmed">
                            Expires: {new Date(zone.billing.expiresAt).toLocaleDateString()}
                        </Text>
                    )}
                    {zone.billing?.renewalCost && (
                        <Text fz="sm" c="dimmed">
                            Renewal: {zone.billing.renewalCost} {zone.billing.currency}
                        </Text>
                    )}
                    {props.publicIp && (
                        <Text fz="sm" c="dimmed">
                            Detected public IP: {props.publicIp}
                        </Text>
                    )}
                </Group>

                {props.isAdmin && (
                    <>
                        <Divider label="Team allocations" />
                        <Text fz="xs" c="dimmed">
                            Teams allowed to use this domain in their project config. A team cannot be removed while its projects still reference the domain.
                        </Text>
                        <Group align="flex-end">
                            <MultiSelect flex={1} data={props.teams.map((t) => ({ value: t.ownerId, label: t.login }))} value={allocations} onChange={setAllocations} placeholder="No teams" searchable />
                            <Button variant="light" loading={busy} onClick={saveAllocations}>
                                Save
                            </Button>
                        </Group>

                        <Divider label="Assigned project" />
                        <Group align="flex-end">
                            <Select flex={1} clearable data={props.projects.map((p) => ({ value: p.id, label: p.id }))} value={assigned} onChange={setAssigned} placeholder="Not assigned" searchable />
                            <Button variant="light" loading={busy} onClick={saveAssignment}>
                                Save
                            </Button>
                        </Group>

                        <Divider label="DNS records" />
                        <Group justify="space-between">
                            <Text fz="sm" c="dimmed">
                                Managed at the domain level. Cloudflare is authoritative.
                            </Text>
                            <Button size="compact-sm" onClick={startNew} disabled={editing !== null}>
                                Add record
                            </Button>
                        </Group>

                        {editing !== null && (
                            <RecordForm
                                draft={draft}
                                setDraft={setDraft}
                                dataJson={dataJson}
                                setDataJson={setDataJson}
                                zoneName={zone.name}
                                reservations={reservations}
                                busy={busy}
                                onCancel={() => setEditing(null)}
                                onSave={saveRecord}
                            />
                        )}

                        <Table striped withRowBorders={false} verticalSpacing="xs" fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Type</Table.Th>
                                    <Table.Th>Name</Table.Th>
                                    <Table.Th>Content</Table.Th>
                                    <Table.Th>TTL</Table.Th>
                                    <Table.Th>Flags</Table.Th>
                                    <Table.Th />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {(records ?? []).map((r) => (
                                    <Table.Tr key={r.id}>
                                        <Table.Td>
                                            <Badge variant="light">{r.type}</Badge>
                                        </Table.Td>
                                        <Table.Td>{r.name}</Table.Td>
                                        <Table.Td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.data ? JSON.stringify(r.data) : r.content}</Table.Td>
                                        <Table.Td>{r.ttl === 1 ? 'auto' : r.ttl}</Table.Td>
                                        <Table.Td>
                                            <Group gap={4}>
                                                {r.proxied && <Badge size="xs" color="orange">proxied</Badge>}
                                                {r.dynamic && <Badge size="xs" color="blue">dynamic</Badge>}
                                                {r.portReservationId && <Badge size="xs" color="teal">port</Badge>}
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={4} justify="flex-end">
                                                <Tooltip label="Edit">
                                                    <ActionIcon variant="subtle" onClick={() => startEdit(r)} disabled={editing !== null}>
                                                        <MdOutlineEdit />
                                                    </ActionIcon>
                                                </Tooltip>
                                                <Tooltip label="Delete">
                                                    <ActionIcon variant="subtle" color="red" onClick={() => deleteRecord(r)} disabled={busy}>
                                                        <MdOutlineDelete />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                                {records && records.length === 0 && (
                                    <Table.Tr>
                                        <Table.Td colSpan={6}>
                                            <Text c="dimmed" fz="sm">
                                                No records.
                                            </Text>
                                        </Table.Td>
                                    </Table.Tr>
                                )}
                            </Table.Tbody>
                        </Table>
                    </>
                )}

                {props.isSuperAdmin && (
                    <>
                        <Divider label="Danger zone" color="red" />
                        <Alert color="red" variant="light" title="Delete domain">
                            <Stack gap="xs">
                                <Text fz="sm">Removes the zone from Cloudflare and best-effort disables auto-renew to stop billing. Type the domain name to confirm.</Text>
                                <Group align="flex-end">
                                    <TextInput flex={1} placeholder={zone.name} value={confirmName} onChange={(e) => setConfirmName(e.currentTarget.value)} />
                                    <Button color="red" disabled={confirmName.trim().toLowerCase() !== zone.name.toLowerCase() || busy} loading={busy} onClick={doDelete}>
                                        Delete
                                    </Button>
                                </Group>
                            </Stack>
                        </Alert>
                    </>
                )}
            </Stack>
        </Modal>
    );
};

interface RecordFormProps {
    draft: Draft;
    setDraft: (d: Draft) => void;
    dataJson: string;
    setDataJson: (s: string) => void;
    zoneName: string;
    reservations: PortReservation[];
    busy: boolean;
    onCancel: () => void;
    onSave: () => void;
}

const RecordForm = (props: RecordFormProps) => {
    const { draft } = props;
    const type = (draft.type || 'A') as DnsRecordType;
    const structured = DNS_STRUCTURED_TYPES.includes(type);
    const portBindable = PORT_BINDABLE.has(type);
    const boundReservation = draft.portReservationId ? props.reservations.find((r) => r.id === draft.portReservationId) : undefined;
    return (
        <Fieldset legend={draft.id ? 'Edit record' : 'New record'}>
            <Stack gap="xs">
                <Group grow>
                    <Select label="Type" data={DNS_RECORD_TYPES as unknown as string[]} value={type} onChange={(v) => props.setDraft({ ...draft, type: (v as DnsRecordType) || 'A' })} />
                    <TextInput label="Name" placeholder={`sub.${props.zoneName} or @`} value={draft.name ?? ''} onChange={(e) => props.setDraft({ ...draft, name: e.currentTarget.value })} />
                    <NumberInput label="TTL (1 = auto)" min={1} value={draft.ttl ?? 1} onChange={(v) => props.setDraft({ ...draft, ttl: typeof v === 'number' ? v : 1 })} />
                </Group>
                {structured ? (
                    <Textarea label="Data (JSON)" description="Structured record fields, e.g. SRV/CAA. See Cloudflare's DNS record data schema." autosize minRows={3} value={props.dataJson} onChange={(e) => props.setDataJson(e.currentTarget.value)} />
                ) : (
                    <TextInput label="Content" placeholder={type === 'A' ? '203.0.113.10' : type === 'CNAME' ? 'target.example.com' : ''} value={draft.content ?? ''} onChange={(e) => props.setDraft({ ...draft, content: e.currentTarget.value })} disabled={!!draft.dynamic && type === 'A'} />
                )}
                {PRIORITY_TYPES.has(type) && <NumberInput label="Priority" min={0} value={draft.priority ?? 0} onChange={(v) => props.setDraft({ ...draft, priority: typeof v === 'number' ? v : 0 })} w={160} />}
                {portBindable && (
                    <Select
                        label="Bind port to reservation"
                        description={boundReservation ? `NSM will set data.port = ${boundReservation.port} and repush this record whenever the reservation changes.` : 'Optional: drive this record\u2019s port from a reserved/forwarded port. Overrides data.port.'}
                        placeholder="Not bound"
                        clearable
                        searchable
                        data={props.reservations.map((r) => ({ value: r.id, label: `${r.projectId} \u00b7 ${r.port}/${r.protocol} (${r.nodeId})${r.label ? ` \u2014 ${r.label}` : ''}` }))}
                        value={draft.portReservationId ?? null}
                        onChange={(v) => props.setDraft({ ...draft, portReservationId: v ?? '' })}
                        nothingFoundMessage="No port reservations"
                    />
                )}
                <Group>
                    {PROXYABLE.has(type) && <Switch label="Cloudflare proxy" checked={!!draft.proxied} onChange={(e) => props.setDraft({ ...draft, proxied: e.currentTarget.checked })} />}
                    {DYNAMIC_CAPABLE.has(type) && <Switch label="Bind to dynamic IP" description="NSM repushes this record when the public IP changes" checked={!!draft.dynamic} onChange={(e) => props.setDraft({ ...draft, dynamic: e.currentTarget.checked })} />}
                </Group>
                <TextInput label="Comment" value={draft.comment ?? ''} onChange={(e) => props.setDraft({ ...draft, comment: e.currentTarget.value })} />
                <Group justify="flex-end">
                    <Button variant="subtle" onClick={props.onCancel} disabled={props.busy}>
                        Cancel
                    </Button>
                    <Button onClick={props.onSave} loading={props.busy}>
                        Save
                    </Button>
                </Group>
            </Stack>
        </Fieldset>
    );
};
