import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Group, PasswordInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { REGISTRAR_PROVIDER_SPECS, RegistrarAccountSummary, RegistrarProvider } from '@mosaiq/nsm-common/types';
import { useTeamRegistrar } from '@/hooks/queries/domainHooks';
import { useSaveTeamRegistrar, useRemoveTeamRegistrar } from '@/hooks/mutations/domainMutations';

const PROVIDER_OPTIONS = Object.values(RegistrarProvider).map((p) => ({ value: p, label: REGISTRAR_PROVIDER_SPECS[p].label }));

// Seed the editable form values from a saved account: non-secret fields are prefilled, secret fields
// stay blank (they are never returned; a blank secret on save preserves the stored value).
const initialValues = (account: RegistrarAccountSummary | null, provider: RegistrarProvider): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const field of REGISTRAR_PROVIDER_SPECS[provider].fields) {
        values[field.key] = field.secret ? '' : (account?.nonSecretValues?.[field.key] ?? '');
    }
    return values;
};

const TeamRegistrarSettings = ({ ownerId }: { ownerId: string }) => {
    const configQuery = useTeamRegistrar(ownerId);
    const config = configQuery.data ?? null;
    const account = config?.account ?? null;
    const canManage = !!config?.canManage;

    const saveMutation = useSaveTeamRegistrar(ownerId);
    const removeMutation = useRemoveTeamRegistrar(ownerId);

    const [provider, setProvider] = useState<RegistrarProvider>(account?.provider ?? RegistrarProvider.CLOUDFLARE);
    const [values, setValues] = useState<Record<string, string>>(() => initialValues(account, provider));

    // Reseed when fresh config arrives (e.g. after save/remove or first load).
    useEffect(() => {
        const next = account?.provider ?? RegistrarProvider.CLOUDFLARE;
        setProvider(next);
        setValues(initialValues(account, next));
    }, [account]);

    const spec = REGISTRAR_PROVIDER_SPECS[provider];
    const configuredSecrets = useMemo(() => new Set(account?.configuredSecrets ?? []), [account]);

    const onProviderChange = (v: string | null) => {
        const next = (v as RegistrarProvider) || RegistrarProvider.CLOUDFLARE;
        setProvider(next);
        setValues(initialValues(next === account?.provider ? account : null, next));
    };

    const save = async () => {
        try {
            await saveMutation.mutateAsync({ provider, values });
            notifications.show({ color: 'green', message: 'Registrar settings saved.' });
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Save failed.' });
        }
    };

    const remove = async () => {
        if (!window.confirm('Remove this registrar from the team? Domains will no longer be managed here. Shared accounts stay for other teams.')) return;
        try {
            await removeMutation.mutateAsync();
            notifications.show({ color: 'green', message: 'Registrar removed.' });
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Remove failed.' });
        }
    };

    return (
        <Card withBorder>
            <Stack>
                <Group justify="space-between" align="center">
                    <Title order={5}>Registrar</Title>
                    {account && <Badge variant="light" color="green">{REGISTRAR_PROVIDER_SPECS[account.provider].label} configured</Badge>}
                </Group>
                <Text fz="xs" c="dimmed">
                    Credentials for the domain registrar this team uses. Secrets are stored server-side and never shown again after saving. Multiple teams pointing at the same account share its domains — editing these settings affects every team using the account.
                </Text>

                {!canManage ? (
                    <Alert color="gray" variant="light">
                        {account ? `This team uses ${REGISTRAR_PROVIDER_SPECS[account.provider].label}.` : 'No registrar is configured for this team.'} Only team owners can change registrar settings.
                    </Alert>
                ) : (
                    <>
                        <Select label="Provider" data={PROVIDER_OPTIONS} value={provider} onChange={onProviderChange} allowDeselect={false} disabled={PROVIDER_OPTIONS.length <= 1} />
                        {spec.fields.map((field) => {
                            const common = {
                                key: field.key,
                                label: field.label,
                                description: field.description,
                                value: values[field.key] ?? '',
                                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValues((prev) => ({ ...prev, [field.key]: e.currentTarget.value })),
                            };
                            if (field.secret) {
                                return <PasswordInput {...common} placeholder={configuredSecrets.has(field.key) ? '•••••••• (leave blank to keep)' : field.required ? 'Required' : ''} />;
                            }
                            return <TextInput {...common} placeholder={field.required ? 'Required' : ''} />;
                        })}
                        <Group justify="space-between">
                            <div>
                                {account && (
                                    <Button variant="light" color="red" onClick={remove} loading={removeMutation.isPending}>
                                        Remove registrar
                                    </Button>
                                )}
                            </div>
                            <Button onClick={save} loading={saveMutation.isPending}>
                                {account ? 'Save changes' : 'Save registrar'}
                            </Button>
                        </Group>
                    </>
                )}
            </Stack>
        </Card>
    );
};

export default TeamRegistrarSettings;
