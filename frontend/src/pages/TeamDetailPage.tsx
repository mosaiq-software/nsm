import { useTeam } from '@/hooks/queries/teamHooks';
import { useSetTeamDefaults, useSetTeamOverride, useDeleteTeamOverride } from '@/hooks/mutations/teamMutations';
import { Capability, TeamType } from '@mosaiq/nsm-common/types';
import { Alert, Avatar, Badge, Button, Center, Checkbox, Group, Loader, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MdOutlineWarningAmber } from 'react-icons/md';

// Order + labels for the capability checkboxes shown in the editor.
const CAPABILITY_LABELS: { cap: Capability; label: string }[] = [
    { cap: Capability.VIEW, label: 'View' },
    { cap: Capability.DEPLOY, label: 'Deploy & logs' },
    { cap: Capability.CONFIGURE, label: 'Configure & env' },
    { cap: Capability.DELETE, label: 'Delete' },
    { cap: Capability.CREATE_PROJECT, label: 'Create projects' },
    { cap: Capability.MANAGE_INCIDENTS, label: 'Manage incidents' },
];

const TeamDetailPage = () => {
    const { ownerId = '' } = useParams();
    const detailQuery = useTeam(ownerId);
    const detail = detailQuery.isLoading ? undefined : (detailQuery.data ?? null);
    const [defaults, setDefaults] = useState<Capability[]>([]);

    const setTeamDefaults = useSetTeamDefaults(ownerId);
    const setTeamOverride = useSetTeamOverride(ownerId);
    const deleteTeamOverride = useDeleteTeamOverride(ownerId);
    const savingDefaults = setTeamDefaults.isPending;

    // Sync the editable defaults draft whenever fresh team data arrives.
    useEffect(() => {
        setDefaults(detailQuery.data?.team.defaultCapabilities ?? []);
    }, [detailQuery.data]);

    const canManage = !!detail?.canManage;

    const toggleDefault = (cap: Capability, checked: boolean) => {
        setDefaults((prev) => (checked ? [...new Set([...prev, cap])] : prev.filter((c) => c !== cap)));
    };

    const saveDefaults = async () => {
        await setTeamDefaults.mutateAsync(defaults);
        notifications.show({ message: 'Default permissions saved', color: 'green' });
    };

    // Persist a member's override as the capabilities granted BEYOND the team default (additive-only).
    const setMemberOverride = async (memberId: string, memberLogin: string, cap: Capability, checked: boolean) => {
        if (!detail) return;
        const member = detail.members.find((m) => m.id === memberId);
        const current = new Set<Capability>(member?.override ?? []);
        if (checked) current.add(cap);
        else current.delete(cap);
        const extra = [...current].filter((c) => !defaults.includes(c));
        if (extra.length === 0) {
            await deleteTeamOverride.mutateAsync(memberId);
        } else {
            await setTeamOverride.mutateAsync({ memberId, memberLogin, capabilities: extra });
        }
    };

    const defaultsChanged = useMemo(() => {
        const a = [...(detail?.team.defaultCapabilities ?? [])].sort().join(',');
        const b = [...defaults].sort().join(',');
        return a !== b;
    }, [detail, defaults]);

    if (detail === undefined) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }
    if (detail === null) {
        return <Text c="dimmed">Team not found.</Text>;
    }

    const team = detail.team;

    return (
        <Stack maw={900}>
            <Group>
                <Title order={2}>{team.login}</Title>
                <Badge variant="light" color={team.type === TeamType.ORGANIZATION ? 'blue' : 'grape'}>
                    {team.type === TeamType.ORGANIZATION ? 'Organization' : 'User'}
                </Badge>
                {team.installed ? <Badge color="green" variant="light">Installed</Badge> : <Badge color="red" variant="light">App not installed</Badge>}
            </Group>

            {!team.installed ? (
                <Alert color="red" icon={<MdOutlineWarningAmber />} title="GitHub App not installed">
                    The NSM GitHub App must be installed on <b>{team.login}</b> to manage this team and deploy its projects. Members and permissions cannot be changed until the App is reinstalled. Existing configuration and permissions are preserved and will be restored automatically once it is.
                </Alert>
            ) : (
                <>
                    {team.type === TeamType.ORGANIZATION && (
                        <Stack gap="xs">
                            <Title order={4}>Default permissions</Title>
                            <Text c="dimmed" size="sm">
                                Every member of {team.login} gets at least these permissions. Overrides can only grant more, never less.
                            </Text>
                            <Group>
                                {CAPABILITY_LABELS.map(({ cap, label }) => (
                                    <Checkbox key={cap} label={label} checked={defaults.includes(cap)} disabled={!canManage} onChange={(e) => toggleDefault(cap, e.currentTarget.checked)} />
                                ))}
                            </Group>
                            {canManage && defaultsChanged && (
                                <Group>
                                    <Button size="xs" loading={savingDefaults} onClick={saveDefaults}>
                                        Save defaults
                                    </Button>
                                    <Button size="xs" variant="subtle" onClick={() => setDefaults(team.defaultCapabilities)}>
                                        Discard
                                    </Button>
                                </Group>
                            )}
                        </Stack>
                    )}

                    <Title order={4}>Members</Title>
                    {team.type === TeamType.USER ? (
                        <Text c="dimmed">This is a personal (user) team. {team.login} has full access to it.</Text>
                    ) : detail.members.length === 0 ? (
                        <Alert color="yellow" icon={<MdOutlineWarningAmber />}>
                            No members could be listed. Ensure the NSM GitHub App has the "Organization members: read" permission on {team.login}.
                        </Alert>
                    ) : (
                        <Table>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Member</Table.Th>
                                    {CAPABILITY_LABELS.map(({ cap, label }) => (
                                        <Table.Th key={cap} style={{ textAlign: 'center' }}>
                                            {label}
                                        </Table.Th>
                                    ))}
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {detail.members.map((member) => (
                                    <Table.Tr key={member.id}>
                                        <Table.Td>
                                            <Group gap="xs">
                                                <Avatar src={member.avatarUrl} radius="xl" size="sm" />
                                                <Text size="sm">{member.login}</Text>
                                                {member.isOwner && (
                                                    <Tooltip label="Organization owner - full access">
                                                        <Badge size="xs" color="yellow" variant="light">
                                                            Owner
                                                        </Badge>
                                                    </Tooltip>
                                                )}
                                            </Group>
                                        </Table.Td>
                                        {CAPABILITY_LABELS.map(({ cap }) => {
                                            const fromDefault = defaults.includes(cap);
                                            const checked = member.isOwner || member.effective.includes(cap);
                                            // Owners are absolute; default-granted caps can't be removed (additive-only).
                                            const disabled = !canManage || member.isOwner || fromDefault;
                                            return (
                                                <Table.Td key={cap} style={{ textAlign: 'center' }}>
                                                    <Checkbox checked={checked} disabled={disabled} onChange={(e) => setMemberOverride(member.id, member.login, cap, e.currentTarget.checked)} style={{ display: 'inline-block' }} />
                                                </Table.Td>
                                            );
                                        })}
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}
                </>
            )}
        </Stack>
    );
};

export default TeamDetailPage;
