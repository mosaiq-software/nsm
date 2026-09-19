import { Alert, Button, Card, Container, Divider, Group, List, Loader, Stack, Switch, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { MdOutlineNotificationsActive } from 'react-icons/md';
import { Capability } from '@mosaiq/nsm-common/types';
import { useMe } from '@/hooks/queries/useMe';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { useEnablePush, useDisablePush, useSendTestNotification, useSetAnyProjectNotification } from '@/hooks/mutations/pushMutations';
import { getProjectNotificationEnabled, isPushSubscribed, isPushSupported } from '@/utils/push';

// User-specific settings. Today this is notification preferences: a per-device push toggle, a test
// button, and a per-project on/off list built from the projects the user can VIEW.
const SettingsPage = () => {
    const meCtx = useMe();
    const api = useAPI();
    const token = api.token;
    const pushSupported = isPushSupported();

    // Distinct projects the user can VIEW, across every team, sorted for stable display.
    const projects = useMemo(() => {
        const seen = new Set<string>();
        const list: string[] = [];
        for (const team of meCtx.teams) {
            for (const p of team.projects) {
                if (p.capabilities.includes(Capability.VIEW) && !seen.has(p.id)) {
                    seen.add(p.id);
                    list.push(p.id);
                }
            }
        }
        return list.sort((a, b) => a.localeCompare(b));
    }, [meCtx.teams]);

    const [subscribed, setSubscribed] = useState(false);
    const enablePushMutation = useEnablePush();
    const disablePushMutation = useDisablePush();
    const sendTestMutation = useSendTestNotification();
    const setProjectNotification = useSetAnyProjectNotification();
    const deviceBusy = enablePushMutation.isPending || disablePushMutation.isPending;
    const testBusy = sendTestMutation.isPending;
    const [projectBusy, setProjectBusy] = useState<Record<string, boolean>>({});

    // Per-project server preferences, one query each. Browser subscription state stays local.
    const prefQueries = useQueries({
        queries: projects.map((id) => ({
            queryKey: queryKeys.pushPreference(id),
            queryFn: async () => (token ? getProjectNotificationEnabled(token, id) : false),
            enabled: !!token && pushSupported,
        })),
    });
    const loadingPrefs = pushSupported && prefQueries.some((q) => q.isLoading);
    const prefs: Record<string, boolean> = Object.fromEntries(projects.map((id, i) => [id, Boolean(prefQueries[i]?.data)]));

    useEffect(() => {
        if (!token || !pushSupported) return;
        let cancelled = false;
        void isPushSubscribed().then((sub) => {
            if (!cancelled) setSubscribed(sub);
        });
        return () => {
            cancelled = true;
        };
    }, [token, pushSupported]);

    const toggleDevice = async () => {
        if (!token) return;
        try {
            if (subscribed) {
                await disablePushMutation.mutateAsync();
                setSubscribed(false);
                notifications.show({ title: 'Push disabled', message: 'This device will no longer receive notifications.', color: 'gray' });
            } else {
                await enablePushMutation.mutateAsync();
                setSubscribed(await isPushSubscribed());
                notifications.show({ title: 'Push enabled', message: 'This device is now set up to receive notifications.', color: 'green' });
            }
        } catch (error) {
            notifications.show({ title: 'Could not update device', message: error instanceof Error ? error.message : 'Failed to update push subscription', color: 'red' });
        }
    };

    const toggleProject = async (projectId: string) => {
        if (!token) return;
        const next = !prefs[projectId];
        setProjectBusy((b) => ({ ...b, [projectId]: true }));
        try {
            await setProjectNotification.mutateAsync({ projectId, enabled: next });
            // Enabling a project may have lazily created a browser subscription; reflect that here.
            if (next) setSubscribed(await isPushSubscribed());
        } catch (error) {
            notifications.show({ title: 'Could not update notifications', message: error instanceof Error ? error.message : 'Failed to update notification settings', color: 'red' });
        } finally {
            setProjectBusy((b) => ({ ...b, [projectId]: false }));
        }
    };

    const sendTest = async () => {
        if (!token) return;
        try {
            const res = await sendTestMutation.mutateAsync();
            setSubscribed(await isPushSubscribed());
            if (res.sent > 0) {
                notifications.show({ title: 'Test notification sent', message: `Delivered to ${res.sent} device(s). Check your notifications.`, color: 'green' });
            } else {
                notifications.show({ title: 'No devices reached', message: 'No active subscriptions received the test. Enable notifications on this device first.', color: 'yellow' });
            }
        } catch (error) {
            notifications.show({ title: 'Could not send test', message: error instanceof Error ? error.message : 'Failed to send test notification', color: 'red' });
        }
    };

    return (
        <Container size="sm" px={0}>
            <Stack>
                <Title order={1}>Settings</Title>
                {meCtx.me?.user.name && <Text c="dimmed">Signed in as {meCtx.me.user.name}</Text>}

                <Card withBorder>
                    <Stack>
                        <Title order={3}>Notifications</Title>

                        {!pushSupported && (
                            <Alert color="yellow" title="Notifications aren't available on this device yet">
                                <Stack gap="xs">
                                    <Text size="sm">NSM delivers browser push notifications. To receive them on a phone:</Text>
                                    <List size="sm">
                                        <List.Item>
                                            <b>iPhone/iPad:</b> open NSM in Safari, tap the Share button, choose &quot;Add to Home Screen&quot;, then open NSM from the new icon and enable notifications here.
                                        </List.Item>
                                        <List.Item>
                                            <b>Android:</b> open NSM in Chrome and enable notifications here (you can also install it from the browser menu).
                                        </List.Item>
                                    </List>
                                </Stack>
                            </Alert>
                        )}

                        {pushSupported && (
                            <Group justify="space-between" wrap="nowrap">
                                <div>
                                    <Text fw={500}>Push on this device</Text>
                                    <Text size="sm" c="dimmed">Allow this browser/device to receive NSM notifications.</Text>
                                </div>
                                <Switch checked={subscribed} onChange={toggleDevice} disabled={deviceBusy} aria-label="Toggle push on this device" />
                            </Group>
                        )}

                        <Group>
                            <Button variant="light" leftSection={<MdOutlineNotificationsActive />} loading={testBusy} onClick={sendTest} disabled={!pushSupported}>
                                Send test notification
                            </Button>
                        </Group>

                        <Divider label="Per-project notifications" labelPosition="left" />

                        {loadingPrefs ? (
                            <Group justify="center">
                                <Loader size="sm" />
                            </Group>
                        ) : projects.length === 0 ? (
                            <Text size="sm" c="dimmed">You don&apos;t have access to any projects yet.</Text>
                        ) : (
                            <Stack gap="xs">
                                {projects.map((id) => (
                                    <Group key={id} justify="space-between" wrap="nowrap">
                                        <Text>{id}</Text>
                                        <Switch checked={Boolean(prefs[id])} onChange={() => toggleProject(id)} disabled={Boolean(projectBusy[id])} aria-label={`Toggle notifications for ${id}`} />
                                    </Group>
                                ))}
                            </Stack>
                        )}
                    </Stack>
                </Card>
            </Stack>
        </Container>
    );
};

export default SettingsPage;
