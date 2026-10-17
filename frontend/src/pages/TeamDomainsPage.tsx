import { useParams } from 'react-router-dom';
import { Stack, Title } from '@mantine/core';
import TeamRegistrarSettings from '@/components/TeamRegistrarSettings';
import TeamDomains from '@/components/TeamDomains';

const TeamDomainsPage = () => {
    const { ownerId = '' } = useParams();

    return (
        <Stack maw={900}>
            <Title order={2}>Domains</Title>
            <TeamRegistrarSettings ownerId={ownerId} />
            <TeamDomains ownerId={ownerId} />
        </Stack>
    );
};

export default TeamDomainsPage;
