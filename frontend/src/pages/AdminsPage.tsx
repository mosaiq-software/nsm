import { useAPI } from '@/utils/api';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Admin } from '@mosaiq/nsm-common/types';
import { ActionIcon, Avatar, Button, Center, Group, Loader, Modal, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { MdOutlineDelete, MdOutlineLaunch, MdOutlineLock } from 'react-icons/md';

interface GhUser {
    login: string;
    avatarUrl: string;
}

// Super-admin-only page to manage NSM admins (individual GitHub users with full access except admin
// management itself). The super admin (VITE_GITHUB_OAUTH_DEFAULT_USER) is implicit and non-removable.
const AdminsPage = () => {
    const api = useAPI();
    const [admins, setAdmins] = useState<Admin[] | undefined>(undefined);
    const [superAdminLogin, setSuperAdminLogin] = useState<string | null>(null);
    const [superAdminInfo, setSuperAdminInfo] = useState<GhUser | null>(null);
    const [modalOpen, setModalOpen] = useState(false);

    const load = async () => {
        const res = await api.get(API_ROUTES.GET_ADMINS, {});
        setAdmins(res?.admins ?? []);
        setSuperAdminLogin(res?.superAdminLogin ?? null);
    };

    useEffect(() => {
        void load();
    }, [api.token]);

    useEffect(() => {
        if (!superAdminLogin) return;
        void getGhInfo(superAdminLogin).then(setSuperAdminInfo);
    }, [superAdminLogin]);

    const handleRemove = async (admin: Admin) => {
        await api.post(API_ROUTES.POST_REMOVE_ADMIN, {}, { id: admin.id });
        setAdmins((prev) => (prev ?? []).filter((a) => a.id !== admin.id));
        notifications.show({ message: `Removed admin ${admin.login}`, color: 'gray' });
    };

    const handleAdd = async (login: string) => {
        const created = await api.post(API_ROUTES.POST_ADD_ADMIN, {}, { login });
        if (!created) {
            notifications.show({ message: 'Could not add admin (GitHub user not found)', color: 'red' });
            return;
        }
        await load();
        setModalOpen(false);
        notifications.show({ message: `Added admin ${created.login}`, color: 'green' });
    };

    return (
        <Stack maw={800}>
            <AddAdminModal opened={modalOpen} onClose={() => setModalOpen(false)} onAdd={handleAdd} />
            <Title order={2}>Access Management</Title>
            <Text c="dimmed">NSM admins have full access to everything except managing this list. Teams and their members are configured separately under Teams.</Text>
            {admins === undefined ? (
                <Center>
                    <Loader />
                </Center>
            ) : (
                <Table>
                    <Table.Tbody>
                        {superAdminLogin && (
                            <Table.Tr>
                                <Table.Td width={50}>
                                    <Avatar src={superAdminInfo?.avatarUrl} radius="xl" onClick={() => window.open(`https://github.com/${superAdminLogin}`, '_blank')} />
                                </Table.Td>
                                <Table.Td>
                                    <Text>{superAdminLogin} (super admin)</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Tooltip label="Super admin - configured in the environment, cannot be removed">
                                        <ActionIcon color="yellow" variant="light">
                                            <MdOutlineLock />
                                        </ActionIcon>
                                    </Tooltip>
                                </Table.Td>
                            </Table.Tr>
                        )}
                        {admins.map((admin) => (
                            <Table.Tr key={admin.id}>
                                <Table.Td width={50}>
                                    <Avatar src={admin.avatarUrl} radius="xl" onClick={() => window.open(`https://github.com/${admin.login}`, '_blank')} />
                                </Table.Td>
                                <Table.Td>
                                    <Text>{admin.login}</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Tooltip label={`Remove admin ${admin.login}`}>
                                        <ActionIcon color="red" variant="light" onClick={() => handleRemove(admin)}>
                                            <MdOutlineDelete />
                                        </ActionIcon>
                                    </Tooltip>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}
            <Button onClick={() => setModalOpen(true)} disabled={admins === undefined} variant="outline" maw={200}>
                Add Admin
            </Button>
        </Stack>
    );
};

const AddAdminModal = (props: { opened: boolean; onClose: () => void; onAdd: (login: string) => void }) => {
    const [login, setLogin] = useState('');
    const [found, setFound] = useState<GhUser | null>(null);

    const lookup = useDebouncedCallback(async () => {
        if (!login.trim()) return setFound(null);
        setFound(await getGhInfo(login.trim()));
    }, 250);

    useEffect(() => {
        lookup();
    }, [login]);

    return (
        <Modal opened={props.opened} onClose={props.onClose} withCloseButton={false}>
            <Stack>
                <Title order={3}>Add Admin</Title>
                <Group>
                    <Avatar src={found?.avatarUrl} radius="xl" />
                    <Stack gap={4}>
                        <TextInput label="GitHub Username" placeholder="e.g., Camo651" value={login} onChange={(e) => setLogin(e.currentTarget.value)} />
                        <Group>
                            <Text c="dimmed" size="xs">
                                {found ? 'User found' : 'No user found'}
                            </Text>
                            <ActionIcon component="a" href={`https://github.com/${found?.login}`} target="_blank" disabled={!found} variant="subtle">
                                <MdOutlineLaunch />
                            </ActionIcon>
                        </Group>
                    </Stack>
                </Group>
                <Group>
                    <Button variant="outline" onClick={props.onClose}>
                        Cancel
                    </Button>
                    <Button disabled={!found} onClick={() => found && props.onAdd(found.login)}>
                        Add
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

const getGhInfo = async (username: string): Promise<GhUser | null> => {
    try {
        const res = await fetch(`https://api.github.com/users/${username}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.type !== 'User') return null;
        return { login: data.login, avatarUrl: data.avatar_url };
    } catch {
        return null;
    }
};

export default AdminsPage;
