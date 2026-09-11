import { useUser } from '@/contexts/user-context';
import { Button, Container, Stack, Title, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MdOutlineDns } from 'react-icons/md';

const LandingPage = () => {
    const [queryParams, setQueryParams] = useSearchParams();
    const token = queryParams.get('token');
    const error = queryParams.get('error');
    const userCtx = useUser();

    useEffect(() => {
        if (token) {
            userCtx.startSession(token);
            setQueryParams({});
        }
        if (error) {
            const error_description = queryParams.get('error_description');
            notifications.show({
                title: 'Authentication Error',
                message: `There was an error during authentication: ${error_description || error}`,
                color: 'red',
            });
            setQueryParams({});
        }
    }, [token, error]);

    return (
        <Container size="sm" pt="20vh">
            <Stack align="center" gap="lg">
                <MdOutlineDns size={64} color="var(--mantine-color-blue-6)" />
                <Title ta="center">Node Server Manager</Title>
                <Text ta="center" c="dimmed">
                    Self-hosted management for your NSM cluster. Sign in with GitHub to manage projects, nodes, and deployments.
                </Text>
                <Button size="md" onClick={() => userCtx.signIn()}>
                    Sign In with GitHub
                </Button>
            </Stack>
        </Container>
    );
};

export default LandingPage;
