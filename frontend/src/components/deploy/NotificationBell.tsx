import { Button, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { MdOutlineNotificationsActive, MdOutlineNotificationsOff } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { useAPI } from '@/utils/api';
import { getProjectNotificationEnabled, isPushSubscribed, isPushSupported, setProjectNotificationEnabled } from '@/utils/push';

interface NotificationBellProps {
    projectId: string;
}

// Per-project notification toggle for the signed-in user. Notifications are opt-out, so the bell is
// "on" only when this browser has a push subscription AND the user has not muted this project.
// Turning it on lazily provisions the browser subscription; turning it off mutes the project for the
// user across all their devices (the browser subscription is left intact for other projects).
export const NotificationBell = ({ projectId }: NotificationBellProps) => {
    const api = useAPI();
    const token = api.token;
    const [enabled, setEnabled] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!token || !isPushSupported()) return;
        let cancelled = false;
        void (async () => {
            const [subscribed, prefEnabled] = await Promise.all([isPushSubscribed(), getProjectNotificationEnabled(token, projectId)]);
            if (!cancelled) setEnabled(subscribed && prefEnabled);
        })();
        return () => {
            cancelled = true;
        };
    }, [token, projectId]);

    if (!token) return null;

    // Push is unavailable in this context (e.g. an uninstalled iOS Safari tab). Point the user to
    // Settings, where the mobile setup instructions live, instead of hiding the control entirely.
    if (!isPushSupported()) {
        return (
            <Tooltip label="Notifications need setup on this device">
                <Button component={Link} to="/settings" variant="light" color="gray" leftSection={<MdOutlineNotificationsOff />}>
                    Set up notifications
                </Button>
            </Tooltip>
        );
    }

    const toggle = async () => {
        const next = !enabled;
        setBusy(true);
        try {
            await setProjectNotificationEnabled(token, projectId, next);
            setEnabled(next && (await isPushSubscribed()));
            notifications.show(
                next
                    ? { title: 'Notifications enabled', message: `You will be notified about deploy events for ${projectId}.`, color: 'green' }
                    : { title: 'Notifications muted', message: `You will no longer receive deploy notifications for ${projectId}.`, color: 'gray' }
            );
        } catch (error) {
            setEnabled(false);
            notifications.show({
                title: 'Could not update notifications',
                message: error instanceof Error ? error.message : 'Failed to update notification settings',
                color: 'red',
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Tooltip label={enabled ? 'Notifications on for this project' : 'Notifications off for this project'}>
            <Button
                variant={enabled ? 'light' : 'default'}
                color={enabled ? 'blue' : 'gray'}
                loading={busy}
                onClick={toggle}
                leftSection={enabled ? <MdOutlineNotificationsActive /> : <MdOutlineNotificationsOff />}
                aria-label="Toggle project notifications"
            >
                {enabled ? 'Notifications on' : 'Notifications off'}
            </Button>
        </Tooltip>
    );
};
