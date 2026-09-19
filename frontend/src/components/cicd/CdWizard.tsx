import { Alert, Autocomplete, Button, Checkbox, Group, List, Stack, Stepper, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { CdTrigger, Project } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { useAPI } from '@/utils/api';

const TRIGGER_LABELS: { value: CdTrigger; label: string; description: string }[] = [
    { value: CdTrigger.PUSH, label: 'On push', description: 'Deploy when commits are pushed to the deploy branch.' },
    { value: CdTrigger.PR_MERGE, label: 'On pull request merge', description: 'Deploy when a pull request into the deploy branch is merged.' },
    { value: CdTrigger.RELEASE, label: 'On release published', description: 'Deploy when a GitHub release is published.' },
    { value: CdTrigger.TAG, label: 'On tag', description: 'Deploy when a tag matching a pattern is pushed.' },
    { value: CdTrigger.SCHEDULE, label: 'On a schedule', description: 'Deploy on a recurring cron schedule (handled by NSM).' },
];

interface CdWizardProps {
    project: Project;
    onComplete: (updated: Project) => void;
    onCancel: () => void;
}

// Multi-step wizard that collects the trigger/branch choices and calls POST_CICD_SETUP to have NSM
// register a GitHub repository webhook (secret + event filter) that drives deployments.
export const CdWizard = ({ project, onComplete, onCancel }: CdWizardProps) => {
    const api = useAPI();
    const [active, setActive] = useState(0);
    const [triggers, setTriggers] = useState<CdTrigger[]>([CdTrigger.PUSH]);
    const [branch, setBranch] = useState(project.repoBranch || 'main');
    const [tagPattern, setTagPattern] = useState('v*');
    const [cron, setCron] = useState('0 0 * * *');
    const [branches, setBranches] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void api.get(API_ROUTES.GET_GITHUB_BRANCHES, {}, { owner: project.repoOwner, repo: project.repoName }).then((res) => {
            if (!cancelled) setBranches(res || []);
        });
        return () => {
            cancelled = true;
        };
    }, [project.repoOwner, project.repoName]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleTrigger = (trigger: CdTrigger, checked: boolean) => {
        setTriggers((prev) => (checked ? [...prev, trigger] : prev.filter((t) => t !== trigger)));
    };

    const has = (trigger: CdTrigger) => triggers.includes(trigger);

    const triggersValid = triggers.length > 0 && (!has(CdTrigger.TAG) || tagPattern.trim().length > 0) && (!has(CdTrigger.SCHEDULE) || cron.trim().length > 0);
    const branchValid = branch.trim().length > 0;

    const nextDisabled = (active === 0 && !triggersValid) || (active === 1 && !branchValid);

    const handleSubmit = async () => {
        setSubmitting(true);
        try {
            const updated = await api.post(
                API_ROUTES.POST_CICD_SETUP,
                { projectId: project.id },
                {
                    branch: branch.trim(),
                    triggers,
                    tagPattern: has(CdTrigger.TAG) ? tagPattern.trim() : undefined,
                    cron: has(CdTrigger.SCHEDULE) ? cron.trim() : undefined,
                }
            );
            if (!updated) {
                notifications.show({ message: 'Failed to set up CI/CD', color: 'red' });
                return;
            }
            notifications.show({ message: 'CI/CD webhook registered', color: 'green' });
            onComplete(updated);
        } catch {
            notifications.show({ message: 'Failed to set up CI/CD', color: 'red' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Stack>
            <Stepper active={active} onStepClick={setActive} size="sm">
                <Stepper.Step label="Triggers" description="When to deploy">
                    <Stack mt="md">
                        <Text size="sm" c="dimmed">
                            Choose one or more events that should trigger a deployment.
                        </Text>
                        {TRIGGER_LABELS.map((t) => (
                            <Stack key={t.value} gap={4}>
                                <Checkbox label={t.label} description={t.description} checked={has(t.value)} onChange={(e) => toggleTrigger(t.value, e.currentTarget.checked)} />
                                {t.value === CdTrigger.TAG && has(CdTrigger.TAG) && (
                                    <TextInput ml="xl" label="Tag pattern" placeholder="v*" value={tagPattern} onChange={(e) => setTagPattern(e.currentTarget.value)} w="24ch" />
                                )}
                                {t.value === CdTrigger.SCHEDULE && has(CdTrigger.SCHEDULE) && (
                                    <TextInput ml="xl" label="Cron schedule (UTC)" placeholder="0 0 * * *" value={cron} onChange={(e) => setCron(e.currentTarget.value)} w="24ch" />
                                )}
                            </Stack>
                        ))}
                    </Stack>
                </Stepper.Step>

                <Stepper.Step label="Branch" description="Deploy branch">
                    <Stack mt="md">
                        <Text size="sm" c="dimmed">
                            The branch watched for push and pull-request triggers.
                        </Text>
                        <Autocomplete label="Deploy branch" data={branches} value={branch} onChange={setBranch} placeholder="main" w="32ch" />
                    </Stack>
                </Stepper.Step>

                <Stepper.Completed>
                    <Stack mt="md">
                        <Text fw={500}>Review</Text>
                        <List size="sm" spacing={4}>
                            <List.Item>
                                Triggers: <b>{triggers.join(', ') || 'none'}</b>
                            </List.Item>
                            <List.Item>
                                Deploy branch: <b>{branch}</b>
                            </List.Item>
                            {has(CdTrigger.TAG) && (
                                <List.Item>
                                    Tag pattern: <b>{tagPattern}</b>
                                </List.Item>
                            )}
                            {has(CdTrigger.SCHEDULE) && (
                                <List.Item>
                                    Cron: <b>{cron}</b>
                                </List.Item>
                            )}
                        </List>
                        <Alert color="blue" variant="light">
                            NSM will register a GitHub repository webhook (with a signing secret and an event filter) via the GitHub App. Deployments are triggered when a delivered event matches these conditions.
                        </Alert>
                    </Stack>
                </Stepper.Completed>
            </Stepper>

            <Group justify="space-between" mt="md">
                <Button variant="default" onClick={active === 0 ? onCancel : () => setActive((s) => s - 1)}>
                    {active === 0 ? 'Cancel' : 'Back'}
                </Button>
                {active < 2 ? (
                    <Button onClick={() => setActive((s) => s + 1)} disabled={nextDisabled}>
                        Next
                    </Button>
                ) : (
                    <Button color="green" onClick={handleSubmit} loading={submitting}>
                        Register webhook
                    </Button>
                )}
            </Group>
        </Stack>
    );
};
