import { ActionIcon, Alert, Badge, Button, Center, Fieldset, Group, Loader, Modal, NumberInput, PasswordInput, Select, Stack, Switch, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { EDITABLE_ENV_SPECS, EnvVarSpec, NodeConfigUpdate, NodeConfigValues } from '@mosaiq/nsm-common/envSchema';
import { useEffect, useMemo, useState } from 'react';
import { MdOutlineVisibilityOff, MdWarningAmber } from 'react-icons/md';
import { useAPI } from '@/utils/api';

interface NodeConfigModalProps {
    nodeId: string;
    isLeader: boolean;
    // Passed by the parent after a fresh admin re-check; the modal also refuses to render fields when false.
    isAdmin: boolean;
    onClose: () => void;
}

// The non-revealable eye affordance shown on secret fields. It looks disabled and, on hover, explains
// why secrets can't be revealed. It is intentionally not a real disabled button so the tooltip fires.
const SecretEye = () => (
    <Tooltip label="This is a secret." withArrow>
        <ActionIcon variant="subtle" color="gray" style={{ cursor: 'not-allowed' }} onClick={(e) => e.preventDefault()} aria-disabled tabIndex={-1}>
            <MdOutlineVisibilityOff />
        </ActionIcon>
    </Tooltip>
);

const categoriesInOrder = (): string[] => {
    const seen: string[] = [];
    for (const s of EDITABLE_ENV_SPECS) if (!seen.includes(s.category)) seen.push(s.category);
    return seen;
};

export const NodeConfigModal = (props: NodeConfigModalProps) => {
    const { nodeId, isLeader, isAdmin } = props;
    const api = useAPI();

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [confirming, setConfirming] = useState(false);
    // Working values for every editable var (booleans/numbers stored as strings). Secrets start empty.
    const [draft, setDraft] = useState<Record<string, string>>({});
    // The initial (normalized) value per non-secret key, used to compute the diff on save.
    const [initial, setInitial] = useState<Record<string, string>>({});
    // Reported character length of each secret's current value (0 when unset).
    const [secretLen, setSecretLen] = useState<Record<string, number>>({});
    // Which secrets the admin has chosen to change (only these are submitted).
    const [secretEditing, setSecretEditing] = useState<Record<string, boolean>>({});

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = (await api.get(API_ROUTES.GET_NODE_CONFIG, { nodeId })) as NodeConfigValues | undefined;
                if (cancelled) return;
                const nextDraft: Record<string, string> = {};
                const nextInitial: Record<string, string> = {};
                const nextSecretLen: Record<string, number> = {};
                for (const spec of EDITABLE_ENV_SPECS) {
                    const v = res?.[spec.key];
                    if (spec.secret) {
                        nextSecretLen[spec.key] = v && 'isSecret' in v && v.isSecret ? v.length : 0;
                        nextDraft[spec.key] = '';
                    } else {
                        const raw = v && !('isSecret' in v && v.isSecret) ? (v.value ?? null) : null;
                        const normalized = raw ?? spec.defaultValue ?? '';
                        nextDraft[spec.key] = normalized;
                        nextInitial[spec.key] = normalized;
                    }
                }
                setDraft(nextDraft);
                setInitial(nextInitial);
                setSecretLen(nextSecretLen);
                setSecretEditing({});
            } catch {
                if (!cancelled) notifications.show({ color: 'red', message: 'Failed to load node configuration.' });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [api, nodeId]);

    const setField = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

    // Build the { set, unset } diff the backend expects: only changed non-secret keys and edited secrets.
    const update = useMemo<NodeConfigUpdate>(() => {
        const set: Record<string, string> = {};
        const unset: string[] = [];
        for (const spec of EDITABLE_ENV_SPECS) {
            if (spec.secret) {
                if (!secretEditing[spec.key]) continue;
                const v = draft[spec.key] ?? '';
                if (v === '') {
                    if ((secretLen[spec.key] ?? 0) > 0) unset.push(spec.key);
                } else {
                    set[spec.key] = v;
                }
            } else {
                const cur = draft[spec.key] ?? '';
                const init = initial[spec.key] ?? '';
                if (cur === init) continue;
                if (cur.trim() === '') unset.push(spec.key);
                else set[spec.key] = cur;
            }
        }
        return { set, unset };
    }, [draft, initial, secretLen, secretEditing]);

    const changeCount = Object.keys(update.set).length + update.unset.length;

    const save = async () => {
        setSaving(true);
        try {
            const res = await api.post(API_ROUTES.POST_NODE_CONFIG, { nodeId }, update);
            if (!res?.ok) throw new Error('Request failed');
            notifications.show({
                color: 'yellow',
                title: 'Node restarting',
                message: isLeader ? `${nodeId} (leader) is restarting. The dashboard may briefly disconnect; leader restart status cannot be verified automatically.` : `${nodeId} is restarting to apply the new configuration. Admins will be notified of the outcome.`,
            });
            props.onClose();
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error && e.message ? e.message : 'Failed to apply configuration.' });
        } finally {
            setSaving(false);
        }
    };

    const renderField = (spec: EnvVarSpec) => {
        const leaderNote = spec.leaderOnly && !isLeader ? (
            <Tooltip label="Only takes effect on the leader node." withArrow>
                <Badge variant="light" color="gray" size="xs">
                    leader only
                </Badge>
            </Tooltip>
        ) : null;
        const labelRow = (
            <Group gap={6} align="center">
                <Text fw={600} size="sm">
                    {spec.label}
                </Text>
                <Text size="xs" c="dimmed">
                    {spec.key}
                </Text>
                {leaderNote}
            </Group>
        );

        if (spec.secret) {
            const editing = !!secretEditing[spec.key];
            const len = secretLen[spec.key] ?? 0;
            return (
                <Stack key={spec.key} gap={4}>
                    {labelRow}
                    <Text size="xs" c="dimmed">
                        {spec.description}
                    </Text>
                    <Group gap="xs" align="flex-end" wrap="nowrap">
                        {editing ? (
                            <PasswordInput style={{ flex: 1 }} placeholder="Enter new value" value={draft[spec.key] ?? ''} onChange={(e) => setField(spec.key, e.currentTarget.value)} visible={false} rightSection={<SecretEye />} />
                        ) : (
                            <PasswordInput style={{ flex: 1 }} value={'\u2022'.repeat(len)} placeholder={len === 0 ? 'Not set' : undefined} disabled visible={false} rightSection={<SecretEye />} />
                        )}
                        {editing ? (
                            <Button variant="subtle" color="gray" onClick={() => setSecretEditing((s) => ({ ...s, [spec.key]: false }))}>
                                Keep current
                            </Button>
                        ) : (
                            <Button variant="light" onClick={() => setSecretEditing((s) => ({ ...s, [spec.key]: true }))}>
                                {len === 0 ? 'Set' : 'Change'}
                            </Button>
                        )}
                    </Group>
                </Stack>
            );
        }

        if (spec.type === 'boolean') {
            return (
                <Stack key={spec.key} gap={4}>
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                        <Stack gap={2}>
                            {labelRow}
                            <Text size="xs" c="dimmed">
                                {spec.description}
                            </Text>
                        </Stack>
                        <Switch checked={(draft[spec.key] ?? 'false') === 'true'} onChange={(e) => setField(spec.key, e.currentTarget.checked ? 'true' : 'false')} />
                    </Group>
                </Stack>
            );
        }

        if (spec.type === 'enum') {
            return <Select key={spec.key} label={labelRow} description={spec.description} data={spec.options ?? []} value={draft[spec.key] ?? ''} onChange={(v) => setField(spec.key, v ?? '')} placeholder={spec.placeholder} clearable={!spec.required} />;
        }

        if (spec.type === 'number') {
            return (
                <NumberInput
                    key={spec.key}
                    label={labelRow}
                    description={spec.description}
                    value={draft[spec.key] === '' || draft[spec.key] === undefined ? '' : Number(draft[spec.key])}
                    onChange={(v) => setField(spec.key, v === '' || v === null || v === undefined ? '' : String(v))}
                    placeholder={spec.placeholder}
                    allowDecimal={false}
                    min={0}
                />
            );
        }

        // string / url
        return <TextInput key={spec.key} label={labelRow} description={spec.description} value={draft[spec.key] ?? ''} onChange={(e) => setField(spec.key, e.currentTarget.value)} placeholder={spec.placeholder} />;
    };

    return (
        <Modal opened onClose={props.onClose} size="xl" title={<Title order={4}>Configure {nodeId}</Title>}>
            {!isAdmin ? (
                <Alert color="red" title="Admins only">
                    You must be an NSM admin to view or edit node configuration.
                </Alert>
            ) : loading ? (
                <Center py="xl">
                    <Loader />
                </Center>
            ) : (
                <Stack>
                    <Alert color="yellow" variant="light" icon={<MdWarningAmber />}>
                        Saving writes this node's <Text span fw={600}>nsm.env</Text> and restarts the daemon so the changes take effect. Only a curated, safe subset of variables is editable here; identity, cluster, and install settings that require a reinstall are not shown.
                    </Alert>

                    {categoriesInOrder().map((cat) => (
                        <Fieldset key={cat} legend={cat}>
                            <Stack gap="md">{EDITABLE_ENV_SPECS.filter((s) => s.category === cat).map(renderField)}</Stack>
                        </Fieldset>
                    ))}

                    {confirming ? (
                        <Alert color="red" variant="light" title="Confirm restart">
                            <Stack gap="sm">
                                <Text size="sm">
                                    {changeCount === 0 ? 'No changes were made.' : `Apply ${changeCount} change${changeCount === 1 ? '' : 's'} and restart ${nodeId}?`}
                                    {isLeader ? ' This node is the leader: the dashboard will briefly disconnect and the restart cannot be verified automatically.' : ' The node will restart; admins will be notified whether it comes back healthy.'}
                                </Text>
                                <Group justify="flex-end">
                                    <Button variant="default" onClick={() => setConfirming(false)} disabled={saving}>
                                        Back
                                    </Button>
                                    <Button color="red" onClick={save} loading={saving} disabled={changeCount === 0}>
                                        Confirm and restart
                                    </Button>
                                </Group>
                            </Stack>
                        </Alert>
                    ) : (
                        <Group justify="space-between">
                            <Text size="sm" c="dimmed">
                                {changeCount === 0 ? 'No changes' : `${changeCount} pending change${changeCount === 1 ? '' : 's'}`}
                            </Text>
                            <Group>
                                <Button variant="default" onClick={props.onClose}>
                                    Cancel
                                </Button>
                                <Button color="yellow" onClick={() => setConfirming(true)} disabled={changeCount === 0}>
                                    Save and Restart Node
                                </Button>
                            </Group>
                        </Group>
                    )}
                </Stack>
            )}
        </Modal>
    );
};

export default NodeConfigModal;
