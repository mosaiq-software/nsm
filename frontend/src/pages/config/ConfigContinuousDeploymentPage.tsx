import { Alert, Autocomplete, Button, Card, Checkbox, Divider, Group, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { CdTrigger } from '@mosaiq/nsm-common/types';
import { useEffect, useState } from 'react';
import { MdOutlineSync } from 'react-icons/md';
import { useGithubBranches } from '@/hooks/queries/githubHooks';
import { useSetupCicd, useRemoveCicd } from '@/hooks/mutations/deployMutations';
import { useUpdateProject, usePatchProjectCache } from '@/hooks/mutations/projectMutations';
import { useMe } from '@/hooks/queries/useMe';
import { RecurrenceInput } from '@/components/cicd/RecurrenceInput';
import { buildCron, DEFAULT_RECURRENCE, describeRecurrence, parseCron, RecurrenceState } from '@/components/cicd/recurrence';
import { useProjectConfig } from './projectConfigContext';

const TRIGGER_LABELS: { value: CdTrigger; label: string; description: string }[] = [
    { value: CdTrigger.PUSH, label: 'On push', description: 'Deploy when commits are pushed to the deploy branch.' },
    { value: CdTrigger.PR_MERGE, label: 'On pull request merge', description: 'Deploy when a pull request into the deploy branch is merged.' },
    { value: CdTrigger.RELEASE, label: 'On release published', description: 'Deploy when a GitHub release is published.' },
    { value: CdTrigger.TAG, label: 'On tag', description: 'Deploy when a tag matching a pattern is pushed.' },
    { value: CdTrigger.SCHEDULE, label: 'On a schedule', description: 'Deploy on a recurring schedule handled by NSM.' },
];

const ConfigContinuousDeploymentPage = () => {
    const { project } = useProjectConfig();
    const meCtx = useMe();
    const setupCicd = useSetupCicd();
    const removeCicd = useRemoveCicd();
    const updateProject = useUpdateProject();
    const patchProject = usePatchProjectCache();

    const projectTeam = meCtx.teams.find((t) => t.projects.some((p) => p.id === project.id));
    const installed = !!projectTeam?.installed;
    const branches = useGithubBranches(project.repoOwner ?? '', project.repoName ?? '').data ?? [];

    const [enabled, setEnabled] = useState(false);
    const [triggers, setTriggers] = useState<CdTrigger[]>([CdTrigger.PUSH]);
    const [branch, setBranch] = useState('main');
    const [tagPattern, setTagPattern] = useState('v*');
    const [recurrence, setRecurrence] = useState<RecurrenceState>(DEFAULT_RECURRENCE);
    const [scheduleImportFailed, setScheduleImportFailed] = useState(false);
    const [allowCICD, setAllowCICD] = useState(false);

    // Seed the form from the persisted project once per project. Local state (not the shared config
    // draft) because managed CD persists through its own endpoints rather than the layout's save flow.
    useEffect(() => {
        const cd = project.cicd;
        setEnabled(!!cd?.managed);
        setTriggers(cd?.triggers?.length ? cd.triggers : [CdTrigger.PUSH]);
        setBranch(cd?.branch || project.repoBranch || 'main');
        setTagPattern(cd?.tagPattern || 'v*');
        const parsed = parseCron(cd?.cron);
        setRecurrence(parsed ?? DEFAULT_RECURRENCE);
        setScheduleImportFailed(!!cd?.cron && !parsed);
        setAllowCICD(!!project.allowCICD);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project.id]);

    const has = (trigger: CdTrigger) => triggers.includes(trigger);
    const toggleTrigger = (trigger: CdTrigger, checked: boolean) => {
        setTriggers((prev) => (checked ? [...prev, trigger] : prev.filter((t) => t !== trigger)));
    };

    const triggersValid = triggers.length > 0 && (!has(CdTrigger.TAG) || tagPattern.trim().length > 0);
    const branchNeeded = has(CdTrigger.PUSH) || has(CdTrigger.PR_MERGE);
    const branchValid = !branchNeeded || branch.trim().length > 0;
    const configValid = !enabled || (triggersValid && branchValid);

    const wasManaged = !!project.cicd?.managed;
    const saving = setupCicd.isPending || removeCicd.isPending || updateProject.isPending;

    const handleSave = async () => {
        notifications.show({ message: 'Saving continuous deployment...', color: 'blue' });
        try {
            // The effective server value of allowCICD after the managed-CD step: setup forces it true,
            // remove leaves it untouched, and with no managed change it stays as persisted.
            let serverAllowCICD = !!project.allowCICD;

            if (enabled) {
                const updated = await setupCicd.mutateAsync({
                    projectId: project.id,
                    branch: branch.trim(),
                    triggers,
                    tagPattern: has(CdTrigger.TAG) ? tagPattern.trim() : undefined,
                    cron: has(CdTrigger.SCHEDULE) ? buildCron(recurrence) : undefined,
                });
                if (!updated) {
                    notifications.show({ message: 'Failed to save continuous deployment', color: 'red' });
                    return;
                }
                patchProject(project.id, { cicd: updated.cicd, allowCICD: updated.allowCICD });
                serverAllowCICD = !!updated.allowCICD;
                setScheduleImportFailed(false);
            } else if (wasManaged) {
                const updated = await removeCicd.mutateAsync(project.id);
                if (!updated) {
                    notifications.show({ message: 'Failed to save continuous deployment', color: 'red' });
                    return;
                }
                patchProject(project.id, { cicd: undefined });
                serverAllowCICD = !!updated.allowCICD;
            }

            if (allowCICD !== serverAllowCICD) {
                await updateProject.mutateAsync({ id: project.id, patch: { allowCICD } });
            }

            notifications.show({ message: 'Continuous deployment saved', color: 'green' });
        } catch {
            notifications.show({ message: 'Failed to save continuous deployment', color: 'red' });
        }
    };

    const cd = project.cicd;

    return (
        <Stack>
            <Group gap="xs">
                <MdOutlineSync />
                <Title order={4}>Continuous Deployment</Title>
            </Group>
            <Text size="sm" c="dimmed">
                Control when NSM automatically deploys this project. Choose the events that should trigger a deployment and, for scheduled deploys, exactly how often it should run.
            </Text>

            {!installed ? (
                <Alert color="yellow" variant="light" title="GitHub App not installed">
                    Install the NSM GitHub App for this project&apos;s organization to enable managed continuous deployment. You can still allow the external deploy-key trigger below.
                </Alert>
            ) : (
                <Card withBorder>
                    <Stack>
                        <Switch
                            label="Enable managed continuous deployment"
                            description="NSM registers a shared GitHub repository webhook and, for scheduled deploys, an internal timer that deploy this project when your chosen events occur."
                            checked={enabled}
                            onChange={(e) => setEnabled(e.currentTarget.checked)}
                        />

                        {enabled && (
                            <>
                                <Divider />
                                <Stack gap="xs">
                                    <Title order={5}>When to deploy</Title>
                                    <Text size="sm" c="dimmed">
                                        Choose one or more events that should trigger a deployment.
                                    </Text>
                                    {TRIGGER_LABELS.map((t) => (
                                        <Stack key={t.value} gap={4}>
                                            <Checkbox label={t.label} description={t.description} checked={has(t.value)} onChange={(e) => toggleTrigger(t.value, e.currentTarget.checked)} />
                                            {t.value === CdTrigger.TAG && has(CdTrigger.TAG) && (
                                                <TextInput ml="xl" label="Tag pattern" placeholder="v*" value={tagPattern} onChange={(e) => setTagPattern(e.currentTarget.value)} w="24ch" />
                                            )}
                                            {t.value === CdTrigger.SCHEDULE && has(CdTrigger.SCHEDULE) && <RecurrenceInput value={recurrence} onChange={setRecurrence} />}
                                        </Stack>
                                    ))}
                                    {scheduleImportFailed && (
                                        <Alert color="yellow" variant="light" ml="xl">
                                            The previous schedule could not be imported into the builder and was reset to a default. Save to replace it.
                                        </Alert>
                                    )}
                                </Stack>

                                <Divider />
                                <Stack gap="xs">
                                    <Title order={5}>Deploy branch</Title>
                                    <Text size="sm" c="dimmed">
                                        The branch watched for push and pull-request triggers.
                                    </Text>
                                    <Autocomplete label="Deploy branch" data={branches} value={branch} onChange={setBranch} placeholder="main" w="32ch" />
                                </Stack>

                                <Alert color="blue" variant="light">
                                    NSM registers a GitHub repository webhook (with a signing secret and an event filter) via the GitHub App. Deployments are triggered when a delivered event matches these conditions.
                                </Alert>
                            </>
                        )}
                    </Stack>
                </Card>
            )}

            <Card withBorder>
                <Stack gap="xs">
                    <Switch
                        label="Allow deploy-key trigger"
                        description="Allow external systems (e.g. a CI pipeline) to trigger a deployment using this project's deploy key."
                        checked={allowCICD}
                        onChange={(e) => setAllowCICD(e.currentTarget.checked)}
                    />
                </Stack>
            </Card>

            {cd?.managed && (
                <Card withBorder>
                    <Stack gap={4}>
                        <Title order={5}>Current configuration</Title>
                        <Text size="sm">
                            Triggers: <b>{cd.triggers.join(', ')}</b>
                        </Text>
                        <Text size="sm">
                            Deploy branch: <b>{cd.branch}</b>
                        </Text>
                        {cd.tagPattern && (
                            <Text size="sm">
                                Tag pattern: <b>{cd.tagPattern}</b>
                            </Text>
                        )}
                        {cd.cron && (
                            <Text size="sm">
                                Schedule: <b>{parseCron(cd.cron) ? describeRecurrence(parseCron(cd.cron)!) : cd.cron}</b>
                            </Text>
                        )}
                        <Text size="xs" c="dimmed">
                            Set up {new Date(cd.setupAt).toLocaleString()}.
                        </Text>
                    </Stack>
                </Card>
            )}

            <Group>
                <Button onClick={handleSave} loading={saving} disabled={!configValid}>
                    Save
                </Button>
            </Group>
        </Stack>
    );
};

export default ConfigContinuousDeploymentPage;
