import { ActionIcon, Group, Stack, Title } from '@mantine/core';
import { Project } from '@mosaiq/nsm-common/types';
import React from 'react';
import { MdOutlineLaunch } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { NotificationBell } from '@/components/deploy/NotificationBell';

interface ProjectHeaderProps {
    project: Project;
    section: string;
}
export const ProjectHeader = (props: ProjectHeaderProps) => {
    return (
        <Stack>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Group>
                    <Title order={1}>{props.project.id}</Title>
                    <ActionIcon variant="subtle" component={Link} to={`https://github.com/${props.project.repoOwner}/${props.project.repoName}`} target="_blank">
                        <MdOutlineLaunch />
                    </ActionIcon>
                </Group>
                <NotificationBell projectId={props.project.id} />
            </Group>
            <Title order={3}>{props.section}</Title>
        </Stack>
    );
};
