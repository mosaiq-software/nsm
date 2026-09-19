import { ActionIcon, Alert, Button, Card, Code, CopyButton, Group, Modal, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Capability } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdOutlineCheckBox, MdOutlineContentCopy, MdOutlineWarningAmber } from 'react-icons/md';
import { useMe } from '@/contexts/me-context';
import { useAPI } from '@/utils/api';
import { ApiKeysCard } from '@/components/ApiKeysCard';
import { useProjectConfig } from './projectConfigContext';

const ConfigKeysPage = () => {
    const { project } = useProjectConfig();
    const meCtx = useMe();
    const api = useAPI();
    const [confirmModal, setConfirmModal] = useState(false);
    const [rotating, setRotating] = useState(false);
    // The raw key is only ever available in-memory right after a rotate; it is never fetched again.
    const [revealedKey, setRevealedKey] = useState<string | null>(null);

    const handleRotate = async () => {
        setRotating(true);
        try {
            const newKey = await api.post(API_ROUTES.POST_RESET_DEPLOYMENT_KEY, { projectId: project.id }, {});
            if (!newKey) {
                notifications.show({ message: 'Failed to rotate deployment key!', color: 'red' });
                return;
            }
            setConfirmModal(false);
            setRevealedKey(newKey);
            notifications.show({ message: 'Deployment key rotated', color: 'green' });
        } finally {
            setRotating(false);
        }
    };

    const canDeploy = meCtx.canProject(project.id, Capability.DEPLOY);
    const revealedDeployUrl = revealedKey ? `${window.location.origin}/deploy/${project.id}/${revealedKey}` : '';

    return (
        <>
            <Modal opened={confirmModal} onClose={() => setConfirmModal(false)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Rotate Deployment Key</Title>
                    <Text>Rotating the deployment key generates a new one and invalidates the old key. Any CI/CD pipeline or script using the old key will stop working until updated.</Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setConfirmModal(false)}>
                            Keep current key
                        </Button>
                        <Button variant="light" color="red" loading={rotating} onClick={() => void handleRotate()}>
                            Rotate key
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Show-once reveal: the raw key and full deploy URL are displayed a single time after rotation. */}
            <Modal opened={!!revealedKey} onClose={() => setRevealedKey(null)} title="Your new deployment key" size="lg">
                <Stack>
                    <Alert color="yellow" icon={<MdOutlineWarningAmber />} title="Copy this now">
                        For security, only a hash of the key is stored. This is the only time it will be shown — copy it before closing.
                    </Alert>
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>
                            Deployment key
                        </Text>
                        <Group wrap="nowrap">
                            <Code style={{ flex: 1, wordBreak: 'break-all' }}>{revealedKey}</Code>
                            <CopyButton value={revealedKey ?? ''}>
                                {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied' : 'Copy key'} withArrow>
                                        <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy}>
                                            {copied ? <MdOutlineCheckBox /> : <MdOutlineContentCopy />}
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </CopyButton>
                        </Group>
                    </Stack>
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>
                            Deploy URL
                        </Text>
                        <Group wrap="nowrap">
                            <Code style={{ flex: 1, wordBreak: 'break-all' }}>{revealedDeployUrl}</Code>
                            <CopyButton value={revealedDeployUrl}>
                                {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied' : 'Copy deploy URL'} withArrow>
                                        <ActionIcon variant={copied ? 'filled' : 'light'} onClick={copy}>
                                            {copied ? <MdOutlineCheckBox /> : <MdOutlineContentCopy />}
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </CopyButton>
                        </Group>
                    </Stack>
                    <Group justify="flex-end">
                        <Button onClick={() => setRevealedKey(null)}>Done</Button>
                    </Group>
                </Stack>
            </Modal>

            <Stack>
                {canDeploy && (
                    <Card withBorder>
                        <Stack>
                            <Title order={5}>Deployment Key</Title>
                            <Text size="sm" c="dimmed">
                                Used to trigger deployments from CI/CD or the deploy URL. For security, only a hash of the key is stored, so the key is shown only once when generated. Rotate to issue a new key (this invalidates the old one).
                            </Text>
                            <Group align="flex-end" wrap="nowrap">
                                <TextInput label="Deployment Key" value={'•••••••••••••••• (hidden)'} readOnly disabled w={'32ch'} />
                                <Button color="red" variant="light" onClick={() => setConfirmModal(true)}>
                                    Rotate Key
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
