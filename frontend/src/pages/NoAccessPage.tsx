import { Alert, Button, Center, Stack, Text, Title } from '@mantine/core';
import { useUser } from '@/contexts/user-context';
import { MdOutlineLock } from 'react-icons/md';

// Shown to a signed-in user who is neither an admin nor a member of any team. Access is granted by an
// admin (adding them as an admin) or by joining a GitHub org/user account that has a team on NSM.
const NoAccessPage = () => {
    const userCtx = useUser();
    return (
        <Center h="100dvh" p="md">
            <Stack maw={480} align="center">
                <Title order={2}>No access yet</Title>
                <Alert color="yellow" icon={<MdOutlineLock />} title={`Signed in as ${userCtx.user?.name ?? ''}`}>
                    <Text>You don't currently have access to anything on NSM. Ask an administrator to grant you access to a team, then reload this page.</Text>
                </Alert>
                <Button variant="light" onClick={() => userCtx.signOut()}>
                    Sign out
                </Button>
            </Stack>
        </Center>
    );
};

export default NoAccessPage;
