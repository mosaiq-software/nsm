import { useAPI } from '@/utils/api';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { Team, TeamType } from '@mosaiq/nsm-common/types';
import { Alert, Badge, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MdOutlineWarningAmber } from 'react-icons/md';

// Admin-only page listing every team NSM knows about. Teams are discovered from GitHub App
// installations (plus any configured-but-uninstalled teams); admins configure them but do not
// create or delete them - installing/uninstalling the App is what adds/removes a team.
const TeamsPage = () => {
    const api = useAPI();
    const [teams, setTeams] = useState<Team[] | undefined>(undefined);

    useEffect(() => {
        void api.get(API_ROUTES.GET_TEAMS, {}).then((res) => setTeams(res ?? []));
    }, [api.token]);

    return (
        <Stack maw={800}>
            <Title order={2}>Teams</Title>
            <Text c="dimmed">Teams are the GitHub organizations and users that have installed the NSM GitHub App. Configure each team's default permissions and per-member overrides from its page.</Text>
            {teams === undefined ? (
                <Center>
                    <Loader />
                </Center>
            ) : teams.length === 0 ? (
                <Alert color="yellow" icon={<MdOutlineWarningAmber />} title="No teams yet">
                    Install the NSM GitHub App on a GitHub organization or user account to create a team.
                </Alert>
            ) : (
                <Stack gap="sm">
                    {teams.map((team) => (
                        <Card key={team.ownerId} withBorder component={Link} to={`/teams/${team.ownerId}`} style={{ textDecoration: 'none' }}>
                            <Group justify="space-between">
                                <Group>
                                    <Text fw={600}>{team.login}</Text>
                                    <Badge variant="light" color={team.type === TeamType.ORGANIZATION ? 'blue' : 'grape'}>
                                        {team.type === TeamType.ORGANIZATION ? 'Organization' : 'User'}
                                    </Badge>
                                </Group>
                                {team.installed ? <Badge color="green" variant="light">Installed</Badge> : <Badge color="red" variant="light" leftSection={<MdOutlineWarningAmber />}>App not installed</Badge>}
                            </Group>
                        </Card>
                    ))}
                </Stack>
            )}
        </Stack>
    );
};

export default TeamsPage;
