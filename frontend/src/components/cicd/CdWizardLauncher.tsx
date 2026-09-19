import { Anchor, Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Project } from '@mosaiq/nsm-common/types';
import { useState } from 'react';
import { MdOutlineDelete, MdOutlineRocketLaunch, MdOutlineSync } from 'react-icons/md';
import { useProjects } from '@/contexts/project-context';
import { useAPI } from '@/utils/api';
import { CdWizard } from './CdWizard';

// Encapsulates the CI/CD setup wizard together with the current-configuration display and the
// setup/remove modals so the Deploy page and the Project config page can launch it identically.
export const CdWizardLauncher = ({ project }: { project: Project }) => {
    const projectCtx = useProjects();
    const api = useAPI();
    const [modal, setModal] = useState<'cd-wizard' | 'cd-remove' | null>(null);
    const [removingCd, setRemovingCd] = useState(false);

    const cd = project.cicd;

    const handleRemoveCd = async () => {
        setRemovingCd(true);
        notifications.show({ message: 'Removing CI/CD...', color: 'orange' });
        try {
            const updated = await api.post(API_ROUTES.POST_CICD_REMOVE, { projectId: project.id }, {});
            if (!updated) {
                notifications.show({ message: 'Failed to remove CI/CD', color: 'red' });
                return;
            }
            projectCtx.update(project.id, { cicd: undefined }, true);
            notifications.show({ message: 'CI/CD removed', color: 'green' });
        } catch {
            notifications.show({ message: 'Failed to remove CI/CD', color: 'red' });
        } finally {
            setRemovingCd(false);
        }
    };

    return (
        <>
            <Modal opened={modal === 'cd-wizard'} onClose={() => setModal(null)} title="Set up Continuous Deployment" size="lg">
                <CdWizard
                    project={project}
                    onCancel={() => setModal(null)}
                    onComplete={(updated) => {
                        projectCtx.update(project.id, { cicd: updated.cicd, allowCICD: updated.allowCICD }, true);
                        setModal(null);
                    }}
                />
            </Modal>
            <Modal opened={modal === 'cd-remove'} onClose={() => setModal(null)} withCloseButton={false}>
                <Stack>
                    <Title order={3}>Remove Continuous Deployment</Title>
                    <Text>
                        This deletes the managed workflow file{cd?.viaPr ? ' and its pull-request branch' : ''} and the deploy-key repository secret. To change the configuration, remove it and run the wizard again.
                    </Text>
                    <Group justify="space-between">
                        <Button variant="filled" onClick={() => setModal(null)}>
                            No. Keep CI/CD.
                        </Button>
                        <Button
                            variant="light"
                            color="red"
                            onClick={() => {
                                void handleRemoveCd();
                                setModal(null);
                            }}
                        >
                            Yes. Remove CI/CD.
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Card withBorder>
                <Stack>
                    <Group justify="space-between">
                        <Group gap="xs">
                            <MdOutlineSync />
                            <Title order={5}>Continuous Deployment</Title>
                        </Group>
                        {cd?.managed ? (
                            <Button variant="light" color="red" leftSection={<MdOutlineDelete />} loading={removingCd} onClick={() => setModal('cd-remove')}>
                                Remove CD
                            </Button>
                        ) : (
                            <Button variant="light" leftSection={<MdOutlineRocketLaunch />} onClick={() => setModal('cd-wizard')}>
                                Set up CI/CD
                            </Button>
                        )}
                    </Group>
                    {cd?.managed ? (
                        <Stack gap={4}>
                            <Text size="sm">
                                Triggers: <b>{cd.triggers.join(', ')}</b>
                            </Text>
                            <Text size="sm">
                                Deploy branch: <b>{cd.branch}</b>
                            </Text>
                            <Text size="sm">
                                Workflow file: <b>{cd.workflowPath}</b>
                            </Text>
                            {cd.prUrl && (
                                <Text size="sm">
                                    Pull request:{' '}
                                    <Anchor href={cd.prUrl} target="_blank" rel="noreferrer">
                                        {cd.prUrl}
                                    </Anchor>
                                </Text>
                            )}
                        </Stack>
                    ) : (
                        <Text size="sm" c="dimmed">
                            Let NSM provision a managed GitHub Actions workflow that deploys this project automatically. The deploy key is stored as an encrypted repository secret.
                        </Text>
                    )}
                </Stack>
            </Card>
        </>
    );
};

export default CdWizardLauncher;
