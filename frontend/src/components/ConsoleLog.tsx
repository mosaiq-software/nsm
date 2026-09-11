import { ActionIcon, Code, Group, Stack, Text } from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { MdOutlineArrowDropUp } from 'react-icons/md';

interface ConsoleLogProps {
    log?: string;
    title?: string;
    defaultOpen?: boolean;
}

export const ConsoleLog = (props: ConsoleLogProps) => {
    const [open, setOpen] = useState(props.defaultOpen || false);
    const scrollBoxRef = React.useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        if (scrollBoxRef.current) {
            scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
        }
    };
    useEffect(() => {
        if (open) {
            scrollToBottom();
        }
    }, [open]);
    return (
        <Stack>
            <Group
                w={'100%'}
                justify="space-between"
                onClick={() => setOpen(!open)}
                style={{
                    cursor: 'pointer',
                }}
            >
                <Text>{props.title}</Text>
                <ActionIcon
                    style={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}
                    variant="light"
                    bdrs={'xl'}
                >
                    <MdOutlineArrowDropUp size={20} />
                </ActionIcon>
            </Group>
            {open && (
                <Group
                    ref={scrollBoxRef}
                    style={{
                        width: '100%',
                        overflow: 'scroll',
                        maxHeight: '700px',
                    }}
                    gap={0}
                >
                    <Code
                        color="var(--mantine-color-blue-light)"
                        block
                        w={'3%'}
                        px={4}
                        ta="right"
                        style={{
                            textOverflow: 'clip',
                            userSelect: 'none',
                            overflow: 'hidden',
                        }}
                    >
                        {Array.from({ length: props.log?.split('\n').length || 1 }, (_, i) => i + 1).join('\n')}
                    </Code>
                    <Code block w={'97%'}>
                        {(props.log ?? '').replace('\r\n', '\n')}
                    </Code>
                </Group>
            )}
        </Stack>
    );
};
