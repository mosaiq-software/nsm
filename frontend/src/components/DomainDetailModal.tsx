import { ActionIcon, Alert, Anchor, Badge, Button, Divider, Fieldset, Group, Modal, MultiSelect, NumberInput, Select, Stack, Switch, Table, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { Sparkline } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import { DnsNameAnalytics, DnsRecord, DnsRecordType, DNS_RECORD_TYPES, DNS_STRUCTURED_TYPES, DnsZone, DnsZoneAnalytics, PortReservation, Team } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { useEffect, useState } from 'react';
import { useAPI } from '@/utils/api';
import { MdOpenInNew, MdOutlineDelete, MdOutlineEdit } from 'react-icons/md';

interface DomainDetailModalProps {
    zone: DnsZone;
    teams: Team[];
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

// Client-only id prefix for records staged for creation but not yet pushed to Cloudflare.
const NEW_ID_PREFIX = 'new:';
const tempId = (): string => `${NEW_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
const isNewRecord = (id: string): boolean => id.startsWith(NEW_ID_PREFIX);

export const DomainDetailModal = (props: DomainDetailModalProps) => {
    const api = useAPI();
    const { zone } = props;
    const [records, setRecords] = useState<DnsRecord[] | null>(null);
    const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
    const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
    const [analytics, setAnalytics] = useState<DnsZoneAnalytics | null>(null);
    const [reservations, setReservations] = useState<PortReservation[]>([]);
    const [editing, setEditing] = useState<null | 'new' | string>(null);
    const [draft, setDraft] = useState<Draft>(emptyDraft());
    const [dataJson, setDataJson] = useState('');
    const [busy, setBusy] = useState(false);

    const [allocations, setAllocations] = useState<string[]>(zone.allocatedTeamIds ?? []);
    const [confirmName, setConfirmName] = useState('');
    const [deleteOpen, setDeleteOpen] = useState(false);

    const billing = zone.billing;
    const currency = billing?.currency ?? '';
    const money = (amount: string): string => `${amount}${currency ? ` ${currency}` : ''}`;
    const renewalNum = parseFloat(billing?.renewalCost ?? '');
    const monthlyEstimate = !isNaN(renewalNum) ? money((renewalNum / 12).toFixed(2)) : null;
    const hasBilling = Boolean(billing?.registrationCost || billing?.renewalCost || billing?.expiresAt);

    const normName = (n: string): string => n.trim().toLowerCase().replace(/\.$/, '');
    const analyticsByName = new Map<string, DnsNameAnalytics>((analytics?.byName ?? []).map((a) => [a.name, a]));

    const loadRecords = async () => {
        if (!props.isAdmin) return;
        const res = await api.get(API_ROUTES.GET_DNS_RECORDS, { zoneId: zone.id });
        setRecords(res ?? []);
        setDeletedIds(new Set());
        setDirtyIds(new Set());
    };

    useEffect(() => {
        void loadRecords();
        if (props.isAdmin) void api.get(API_ROUTES.GET_DNS_ANALYTICS, { zoneId: zone.id }).then((res) => setAnalytics(res ?? null));
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

    // Stage a record add/edit into the local working list. Nothing is pushed to Cloudflare until Save.
    const applyRecord = () => {
        if (!draft.type || !draft.name) {
            notifications.show({ color: 'red', message: 'Type and name are required.' });
            return;
        }
        const staged: DnsRecord = { ...(draft as DnsRecord), zoneId: zone.id };
        if (DNS_STRUCTURED_TYPES.includes(draft.type)) {
            if (dataJson.trim()) {
                try {
                    staged.data = JSON.parse(dataJson);
                } catch {
                    notifications.show({ color: 'red', message: 'Record data must be valid JSON.' });
                    return;
                }
            } else {
                staged.data = undefined;
            }
        }

        if (editing === 'new') {
            staged.id = tempId();
            setRecords((prev) => [...(prev ?? []), staged]);
        } else {
            const id = editing as string;
            staged.id = id;
            setRecords((prev) => (prev ?? []).map((r) => (r.id === id ? staged : r)));
            if (!isNewRecord(id)) setDirtyIds((prev) => new Set(prev).add(id));
        }
        setEditing(null);
    };

    // Remove a record from the working list. Existing (already-synced) records are queued for deletion.
    const removeRecord = (r: DnsRecord) => {
        setRecords((prev) => (prev ?? []).filter((x) => x.id !== r.id));
        if (!isNewRecord(r.id)) setDeletedIds((prev) => new Set(prev).add(r.id));
        setDirtyIds((prev) => {
            const next = new Set(prev);
            next.delete(r.id);
            return next;
        });
        if (editing === r.id) setEditing(null);
    };

    const recordBody = (r: DnsRecord): Draft => {
        const body: Draft = { ...r };
        delete (body as { id?: string }).id;
        return body;
    };

    // Single Save: persist team allocations, then push staged DNS record deletes/updates/creates.
    const saveAll = async () => {
        setBusy(true);
        try {
            const alloc = await api.post(API_ROUTES.POST_DOMAIN_ALLOCATIONS, { zoneId: zone.id }, { ownerIds: allocations });
            if (alloc && alloc.ok === false) {
                const list = (alloc.blockedBy || []).map((b) => `${b.projectId} (${b.ownerLogin})`).join(', ');
                notifications.show({ color: 'red', title: 'Domain in use', message: `Cannot remove a team while these projects use the domain: ${list}` });
                setAllocations(zone.allocatedTeamIds ?? []);
                return;
            }

            const errors: string[] = [];
            const working = records ?? [];

            for (const id of deletedIds) {
                try {
                    await api.post(API_ROUTES.POST_DNS_RECORD_DELETE, { zoneId: zone.id, recordId: id }, {});
                } catch (e) {
                    errors.push(e instanceof Error ? e.message : 'delete failed');
                }
            }
            for (const r of working) {
                if (!dirtyIds.has(r.id)) continue;
                try {
                    const res = await api.post(API_ROUTES.POST_DNS_RECORD_UPDATE, { zoneId: zone.id, recordId: r.id }, recordBody(r));
                    if (res === undefined) throw new Error(`Failed to update ${r.name}`);
                } catch (e) {
                    errors.push(e instanceof Error ? e.message : `Failed to update ${r.name}`);
                }
            }
            for (const r of working) {
                if (!isNewRecord(r.id)) continue;
                try {
                    const res = await api.post(API_ROUTES.POST_DNS_RECORD_CREATE, { zoneId: zone.id }, recordBody(r));
                    if (res === undefined) throw new Error(`Failed to create ${r.name}`);
                } catch (e) {
                    errors.push(e instanceof Error ? e.message : `Failed to create ${r.name}`);
                }
            }

            await loadRecords();
            props.onChanged();
            if (errors.length) {
                notifications.show({ color: 'red', title: 'Some changes failed', message: errors.join('; ') });
            } else {
                notifications.show({ color: 'green', message: 'Changes saved.' });
            }
        } finally {
            setBusy(false);
        }
    };

    const doDelete = async () => {
        setBusy(true);
        try {
            await api.post(API_ROUTES.POST_DOMAIN_DELETE, { zoneId: zone.id }, { confirmName });
            notifications.show({ color: 'green', message: `${zone.name} deleted from Cloudflare.` });
            setDeleteOpen(false);
            props.onChanged();
            props.onClose();
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Delete failed.' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Modal opened onClose={props.onClose} size="xl" closeOnClickOutside={false} title={<Title order={4}>{zone.name}</Title>}>
            <Stack>
                {zone.dashboardUrl && (
                    <Anchor href={zone.dashboardUrl} target="_blank" rel="noopener noreferrer" fz="sm">
                        <Group gap={4} align="center">
                            View on Cloudflare
                            <MdOpenInNew />
                        </Group>
                    </Anchor>
                )}
                <Group gap="xs">
                    <Badge color={zone.status === 'active' ? 'green' : 'yellow'} variant="light">
                        {zone.status}
                    </Badge>
                    {zone.paused && <Badge color="orange">paused</Badge>}
                    {zone.billing?.registrationStatus && <Badge variant="outline">{zone.billing.registrationStatus}</Badge>}
                    {zone.billing?.autoRenew !== undefined && <Badge variant="outline">auto-renew {zone.billing.autoRenew ? 'on' : 'off'}</Badge>}
                </Group>
                {hasBilling && (
                    <>
                        <Divider label="Billing" />
                        <Group gap="xl">
                            {zone.billing?.registrationCost && (
                                <Text fz="sm">
                                    <Text span c="dimmed">Registration: </Text>
                                    {money(zone.billing.registrationCost)}
                                    <Text span c="dimmed"> (one-time)</Text>
                                </Text>
                            )}
                            {zone.billing?.renewalCost && (
                                <Text fz="sm">
                                    <Text span c="dimmed">Renewal: </Text>
                                    {money(zone.billing.renewalCost)}
                                    <Text span c="dimmed">/yr</Text>
                                </Text>
                            )}
                            {monthlyEstimate && (
                                <Text fz="sm">
                                    <Text span c="dimmed">Est. monthly: </Text>
                                    {monthlyEstimate}
                                </Text>
                            )}
                            {zone.billing?.expiresAt && (
                                <Text fz="sm">
                                    <Text span c="dimmed">Expires: </Text>
                                    {new Date(zone.billing.expiresAt).toLocaleDateString()}
                                </Text>
                            )}
                        </Group>
                    </>
                )}
                {props.publicIp && (
                    <Text fz="sm" c="dimmed">
                        Detected public IP: {props.publicIp}
                    </Text>
                )}

                {props.isAdmin && (
                    <>
                        <Divider label="Team allocations" />
                        <Text fz="xs" c="dimmed">
                            Teams allowed to use this domain in their project config. A team cannot be removed while its projects still reference the domain.
                        </Text>
                        <MultiSelect data={props.teams.map((t) => ({ value: t.ownerId, label: t.login }))} value={allocations} onChange={setAllocations} placeholder="No teams" searchable />

                        <Divider label="DNS records" />
                        <Group justify="space-between" align="center">
                            <Text fz="sm" c="dimmed">
                                Managed at the domain level. Cloudflare is authoritative.
                            </Text>
                            <Group gap="sm" align="center">
                                {analytics && analytics.total > 0 && (
                                    <Tooltip label={`${analytics.total.toLocaleString()} DNS queries from ${analytics.since} to ${analytics.until}`}>
                                        <Group gap={6} align="center">
                                            <Sparkline w={90} h={26} data={analytics.totalSeries.map((p) => p.count)} curveType="monotone" color="blue" fillOpacity={0.2} strokeWidth={1.5} />
                                            <Text fz="xs" c="dimmed">
                                                {analytics.total.toLocaleString()} queries / 7d
                                            </Text>
                                        </Group>
                                    </Tooltip>
                                )}
                                <Button size="compact-sm" onClick={startNew} disabled={editing !== null}>
                                    Add record
                                </Button>
                            </Group>
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
                                onSave={applyRecord}
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
                                    <Table.Th>Traffic (7d)</Table.Th>
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
                                            <RecordTraffic stats={analyticsByName.get(normName(r.name))} loading={props.isAdmin && analytics === null} />
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap={4} justify="flex-end">
                                                <Tooltip label="Edit">
                                                    <ActionIcon variant="subtle" onClick={() => startEdit(r)} disabled={editing !== null}>
                                                        <MdOutlineEdit />
                                                    </ActionIcon>
                                                </Tooltip>
                                                <Tooltip label="Remove">
                                                    <ActionIcon variant="subtle" color="red" onClick={() => removeRecord(r)} disabled={busy}>
                                                        <MdOutlineDelete />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                                {records && records.length === 0 && (
                                    <Table.Tr>
                                        <Table.Td colSpan={7}>
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

                {props.isAdmin && (
                    <Group justify="space-between" mt="md">
                        <div>
                            {props.isSuperAdmin && (
                                <Button color="red" variant="light" onClick={() => setDeleteOpen(true)}>
                                    Delete domain
                                </Button>
                            )}
                        </div>
                        <Button loading={busy} onClick={saveAll}>
                            Save
                        </Button>
                    </Group>
                )}
            </Stack>
            </Modal>

            <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title={<Title order={4} c="red">Delete domain</Title>}>
                <Alert color="red" variant="light">
                    <Stack gap="xs">
                        <Text fz="sm">Removes {zone.name} from Cloudflare and best-effort disables auto-renew to stop billing. This cannot be undone. Type the domain name to confirm.</Text>
                        <TextInput placeholder={zone.name} value={confirmName} onChange={(e) => setConfirmName(e.currentTarget.value)} />
                        <Group justify="flex-end">
                            <Button variant="subtle" color="gray" onClick={() => setDeleteOpen(false)} disabled={busy}>
                                Cancel
                            </Button>
                            <Button color="red" disabled={confirmName.trim().toLowerCase() !== zone.name.toLowerCase() || busy} loading={busy} onClick={doDelete}>
                                Delete
                            </Button>
                        </Group>
                    </Stack>
                </Alert>
            </Modal>
        </>
    );
};

interface RecordTrafficProps {
    stats?: DnsNameAnalytics;
    loading: boolean;
}

// Per-record 7-day DNS query traffic: a sparkline plus the total, or a placeholder when there is no
// data (record never queried, or analytics unavailable).
const RecordTraffic = ({ stats, loading }: RecordTrafficProps) => {
    if (loading) {
        return (
            <Text fz="xs" c="dimmed">
                &hellip;
            </Text>
        );
    }
    if (!stats || stats.total === 0) {
        return (
            <Text fz="xs" c="dimmed">
                &mdash;
            </Text>
        );
    }
    return (
        <Tooltip label={`${stats.total.toLocaleString()} queries in the last 7 days`}>
            <Group gap={6} align="center" wrap="nowrap">
                <Sparkline w={70} h={22} data={stats.series.map((p) => p.count)} curveType="monotone" color="teal" fillOpacity={0.2} strokeWidth={1.5} />
                <Text fz="xs">{stats.total.toLocaleString()}</Text>
            </Group>
        </Tooltip>
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
                    <Button onClick={props.onSave} disabled={props.busy}>
                        Apply
                    </Button>
                </Group>
            </Stack>
        </Fieldset>
    );
};
