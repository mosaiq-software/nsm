import { Badge, Card, Center, Group, Loader, Text } from '@mantine/core';
import { useEffect, useLayoutEffect, useRef } from 'react';

interface BuildLogConsoleProps {
    log?: string;
    live?: boolean;
    title?: string;
}

// Terminal-style viewer for the deployment build log (a raw accumulating string, not stored in
// Loki). Auto-scrolls to the newest line while it is tailing, unless the user has scrolled up.
export const BuildLogConsole = ({ log, live, title = 'Build Log' }: BuildLogConsoleProps) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const pinnedToBottom = useRef(true);

    const text = (log ?? '').replace(/\r\n/g, '\n');
    const lineCount = text.length ? text.split('\n').length : 0;

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
    }, [text]);

    // Re-pin to the bottom whenever a fresh log is shown (e.g. switching instances).
    useEffect(() => {
        pinnedToBottom.current = true;
    }, [live]);

    return (
        <Card withBorder p={0} style={{ overflow: 'hidden' }}>
            <Group justify="space-between" px="sm" py={6} style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                <Text fz="sm" fw={600}>
                    {title}
                </Text>
                {live && (
                    <Badge color="red" variant="light" size="sm" leftSection={<Loader size={10} color="red" />}>
                        Live
                    </Badge>
                )}
            </Group>
            {lineCount === 0 ? (
                <Center py="xl">
                    <Text c="dimmed" fz="sm">
                        {live ? 'Waiting for build output...' : 'No build log for this deployment.'}
                    </Text>
                </Center>
            ) : (
                <div
                    ref={scrollRef}
                    onScroll={onScroll}
                    style={{
                        maxHeight: 480,
                        overflow: 'auto',
                        background: 'var(--mantine-color-dark-8)',
                        fontFamily: 'var(--mantine-font-family-monospace)',
                        fontSize: 'var(--mantine-font-size-xs)',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                    }}
                >
                    <pre
                        style={{
                            margin: 0,
                            padding: '8px 8px 8px 12px',
                            textAlign: 'right',
                            color: 'var(--mantine-color-dark-2)',
                            userSelect: 'none',
                            whiteSpace: 'pre',
                        }}
                    >
                        {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                    </pre>
                    <pre
                        style={{
                            margin: 0,
                            padding: '8px 12px',
                            color: 'var(--mantine-color-gray-1)',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {text}
                    </pre>
                </div>
            )}
        </Card>
    );
};
