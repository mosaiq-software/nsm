import { ActionIcon, Box, Button, Card, CopyButton, Divider, Group, Modal, PasswordInput, Stack, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdOutlineCheckBox, MdOutlineInsertLink, MdOutlineKey } from 'react-icons/md';
import { useProjects } from '@/contexts/project-context';
import { useMe } from '@/contexts/me-context';
import { useAPI } from '@/utils/api';
import { ApiKeysCard } from '@/components/ApiKeysCard';
import { useProjectConfig } from './projectConfigContext';

const ConfigKeysPage = () => {
    const { project } = useProjectConfig();
    const projectCtx = useProjects();
    const meCtx = useMe();
    const api = useAPI();
    const [resetModal, setResetModal] = useState(false);

    const handleResetDeployKey = async () => {
        notifications.show({ message: 'Resetting deployment key...', color: 'blue' });
        const newKey = await api.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, { projectId: project.id }, {});
        if (!newKey) {
            notifications.show({ message: 'Failed to reset deployment key!', color: 'red' });
            return;
        }
        notifications.show({ message: 'Deployment key reset successful!', color: 'green' });
        projectCtx.update(project.id, { deploymentKey: newKey }, true);
    };

    const deployUrl = `${window.location.origin}/deploy/${project.id}/${project.deploymentKey}`;
    const canDeploy = meCtx.canProject(project.id, Capability.DEPLOY);

    return (
        <>
            <Modal opened={resetModal} onClose={() => setResetModal(false)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Reset Deployment Key</Title>
                    <Text>Resetting the deployment key will regenerate it. All CI/CD pipelines using the old key will fail.</Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setResetModal(false)}>
                            No. Keep The Key.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                void handleResetDeployKey();
                                setResetModal(false);
                            }}
                        >
                            Yes. Reset The Key.
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Stack>
                {canDeploy && (
                    <Card withBorder>
                        <Stack>
                            <Title order={5}>Deployment Key</Title>
                            <Text size="sm" c="dimmed">
                                Used to trigger deployments from CI/CD or the deploy URL. Resetting it invalidates any pipeline using the old key.
                            </Text>
                            <Group align="flex-end" wrap="nowrap">
                                <PasswordInput label="Deployment Key" value={project.deploymentKey} readOnly w={'32ch'} />
                                <CopyButton value={project.deploymentKey ?? ''}>
                                    {({ copied, copy }) => (
                                        <Tooltip label={'Copy key'} withArrow>
                                            <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy} size="input-sm">
                                                {copied ? <MdOutlineCheckBox /> : <MdOutlineKey />}
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                </CopyButton>
                                <CopyButton value={deployUrl}>
                                    {({ copied, copy }) => (
                                        <Tooltip label={'Copy Deploy URL'} withArrow>
                                            <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy} size="input-sm">
                                                {copied ? <MdOutlineCheckBox /> : <MdOutlineInsertLink />}
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                </CopyButton>
                                <Box flex={1} h="md">
                                    <Divider />
                                </Box>
                                <Button color="red" variant="light" onClick={() => setResetModal(true)}>
                                    Reset Key
                                </Button>
                            </Group>
                        </Stack>
                    </Card>
                )}
                {meCtx.canProject(project.id, Capability.CONFIGURE) && <ApiKeysCard projectId={project.id} />}
            </Stack>
        </>
    );
};

export default ConfigKeysPage;
