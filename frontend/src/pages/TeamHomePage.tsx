import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Center, Stack, Text, Title } from '@mantine/core';
import { useUser } from '@/contexts/user-context';

// The team root view: no project is selected yet, so prompt the user to pick one from the sidebar.
// Also completes the OAuth session handoff when GitHub redirects back to `/` with a `token` param.
const TeamHomePage = () => {
    const [params, setParams] = useSearchParams();
    const token = params.get('token');
    const userCtx = useUser();

    useEffect(() => {
        if (token) {
            userCtx.startSession(token);
            setParams({});
        }
    }, [token]);

    return (
        <Center mih="60vh">
            <Stack align="center" gap="xs">
                <Title order={3}>Pick a project</Title>
                <Text c="dimmed" size="sm" ta="center" maw={420}>
                    Select a project from the sidebar to get started, or switch teams using the dropdown in the top left.
                </Text>
            </Stack>
        </Center>
    );
};

export default TeamHomePage;
