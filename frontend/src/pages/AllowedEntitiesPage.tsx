import { useUser } from '@/contexts/user-context';
import { useAPI } from '@/utils/api';
import { Alert, Avatar, ActionIcon, Button, Center, Group, Loader, Modal, Space, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { AllowedEntityType, AllowedGithubEntity } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { MdOutlineDelete, MdOutlineLaunch, MdOutlineLock } from 'react-icons/md';

const AllowedEntitiesPage = () => {
    const api = useAPI();
    const userCtx = useUser();
    const [allowedEntities, setAllowedEntities] = useState<AllowedGithubEntity[] | undefined>(undefined);
    const [editedEntities, setEditedEntities] = useState<AllowedGithubEntity[]>([]);
    const [adminUser, setAdminUser] = useState<AllowedGithubEntity | null>(null);
    const [modal, setModal] = useState<'add-entity' | null>(null);

    useEffect(() => {
        const fetchAllowedEntities = async () => {
            const response = await api.get(API_ROUTES.GET_ALLOWED_ENTITIES, {});
            setAllowedEntities(response);
            setEditedEntities(response ?? []);
        };
        fetchAllowedEntities();

        const fetchAdminUser = async () => {
            const id = import.meta.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
            if (!id) return;
            const user = await getGhInfo(id.toLowerCase());
            setAdminUser(user);
        };
        fetchAdminUser();
    }, []);

    const handleAddEntity = (entity: AllowedGithubEntity) => {
        const exists = editedEntities.find((e) => e.id === entity.id);
        if (!exists) {
            setEditedEntities((prev) => [...prev, entity]);
        }
    };

    const handleRemoveEntity = (entity: AllowedGithubEntity) => {
        setEditedEntities((prev) => prev.filter((e) => e.id !== entity.id));
    };

    const handleSaveChanges = async () => {
        await api.post(API_ROUTES.POST_SET_ALLOWED_ENTITIES, {}, { entities: editedEntities });
        setAllowedEntities(editedEntities);
        notifications.show({ message: 'Allowed entities updated', color: 'green' });
    };

    const handleDiscardChanges = () => {
        setEditedEntities(allowedEntities || []);
    };

    const isSame = JSON.stringify(allowedEntities) === JSON.stringify(editedEntities);

    return (
        <Stack maw={800}>
            <AddEntityModal opened={modal === 'add-entity'} onClose={() => setModal(null)} onAddEntity={handleAddEntity} />
            <Group>
                <Title order={2}>Access Management</Title>
            </Group>
            <Text size="lg" c="dimmed">
                Allowed Github Users and Organizations
            </Text>
            {!isSame && (
                <Alert color="yellow" title="Unsaved Changes">
                    <Text>Any removals will logout all users!</Text>
                    <Group>
                        <Button variant="outline" onClick={handleDiscardChanges}>
                            Discard Changes
                        </Button>
                        <Button onClick={handleSaveChanges}>Save Changes</Button>
                    </Group>
                </Alert>
            )}
            {allowedEntities === undefined ? (
                <Center>
                    <Loader />
                </Center>
            ) : editedEntities.length === 0 && !adminUser ? (
                <Text c="dimmed">No allowed entities found.</Text>
            ) : (
                <Table>
                    <Table.Tbody>
                        {adminUser && (
                            <Table.Tr>
                                <Table.Td width={50}>
                                    <Avatar src={adminUser.avatarUrl} alt={adminUser.id} radius="xl" onClick={() => window.open(`https://github.com/${adminUser.id}`, '_blank')} />
                                </Table.Td>
                                <Table.Td>
                                    <Text>{adminUser.type === AllowedEntityType.USER ? `${adminUser.id}` : `Any member of ${adminUser.id}`}</Text>
                                </Table.Td>
                                <Table.Td>
                                    <Tooltip label={`Admin User - Cannot be removed`}>
                                        <ActionIcon color="yellow" variant="light">
                                            <MdOutlineLock />
                                        </ActionIcon>
                                    </Tooltip>
                                </Table.Td>
                            </Table.Tr>
                        )}
                        <Space h="md" />
                        {editedEntities.map((entity) => {
                            return (
                                <Table.Tr key={entity.id}>
                                    <Table.Td width={50}>
                                        <Avatar src={entity.avatarUrl} alt={entity.id} radius="xl" onClick={() => window.open(`https://github.com/${entity.id}`, '_blank')} />
                                    </Table.Td>
                                    <Table.Td>
                                        <Text>{entity.type === AllowedEntityType.USER ? `${entity.id}` : `Any member of ${entity.id}`}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Tooltip label={userCtx.user?.name.toLowerCase() === entity.id.toLowerCase() ? `Cannot remove yourself` : `Remove ${entity.type.toLowerCase()}`}>
                                            <ActionIcon color="red" onClick={() => handleRemoveEntity(entity)} variant="light" disabled={userCtx.user?.name.toLowerCase() === entity.id.toLowerCase()}>
                                                <MdOutlineDelete />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            )}
            <Button onClick={() => setModal('add-entity')} disabled={allowedEntities === undefined} variant="outline" maw={200}>
                Add Entity
            </Button>
        </Stack>
    );
};

interface AddEntityModalProps {
    opened: boolean;
    onClose: () => void;
    onAddEntity: (entity: AllowedGithubEntity) => void;
}
const AddEntityModal = (props: AddEntityModalProps) => {
    const [entityId, setEntityId] = useState('');
    const [fetchedEntity, setFetchedEntity] = useState<AllowedGithubEntity | null>(null);

    const handleAddEntity = async () => {
        if (fetchedEntity) {
            props.onAddEntity(fetchedEntity);
            setEntityId('');
            setFetchedEntity(null);
            props.onClose();
        } else {
            notifications.show({ message: 'Please enter a valid GitHub username or organization.', color: 'red' });
        }
    };

    const fetchEntity = useDebouncedCallback(async () => {
        if (entityId.trim() === '') {
            setFetchedEntity(null);
            return;
        }
        const ghInfo = await getGhInfo(entityId.trim());
        setFetchedEntity(ghInfo);
    }, 250);

    useEffect(() => {
        fetchEntity();
    }, [entityId]);

    return (
        <Modal opened={props.opened} onClose={props.onClose} withCloseButton={false}>
            <Stack>
                <Title order={3}>Add Entity</Title>
                <Group>
                    <Avatar src={fetchedEntity?.avatarUrl} alt={fetchedEntity?.id || 'No Avatar'} radius="xl" />
                    <Stack gap={4}>
                        <TextInput label="GitHub Username or Organization" placeholder="e.g., Camo651 or mosaiq-software" value={entityId} onChange={(event) => setEntityId(event.currentTarget.value)} />
                        <Group>
                            <Text c="dimmed" size="xs">
                                {fetchedEntity?.type === AllowedEntityType.USER ? 'User found' : fetchedEntity?.type === AllowedEntityType.ORGANIZATION ? 'Organization found' : 'No entity found'}
                            </Text>
                            <ActionIcon component="a" href={`https://github.com/${fetchedEntity?.id}`} target="_blank" disabled={!fetchedEntity} variant="subtle">
                                <MdOutlineLaunch />
                            </ActionIcon>
                        </Group>
                    </Stack>
                </Group>
                <Group>
                    <Button variant="outline" onClick={props.onClose}>
                        Cancel
                    </Button>
                    <Button disabled={!fetchedEntity} variant="filled" onClick={handleAddEntity}>
                        Add
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

const getGhInfo = async (username: string): Promise<AllowedGithubEntity | null> => {
    const uri = `https://api.github.com/users/${username}`;
    try {
        const res = await fetch(uri);
        if (res.ok) {
            const data = await res.json();
            return {
                id: data.login,
                avatarUrl: data.avatar_url,
                type: data.type === 'User' ? AllowedEntityType.USER : AllowedEntityType.ORGANIZATION,
            };
        }
    } catch (error) {
        console.error('Error fetching avatar URL:', error);
    }
    return null;
};

export default AllowedEntitiesPage;
