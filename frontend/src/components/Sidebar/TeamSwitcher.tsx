import { Avatar, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { MdCheck, MdExpandMore, MdOutlineWarningAmber } from 'react-icons/md';
import { useNavigate } from 'react-router-dom';
import { NSM_TEAM_ID, SelectableTeam, useSelectedTeam } from '@/contexts/selected-team-context';

interface TeamSwitcherProps {
    onNavigate?: () => void;
}

// MeTeam has no avatar field, so fall back to GitHub's avatar endpoint for real teams; the synthetic
// NSM Admin team uses the app favicon.
const teamAvatarSrc = (team: SelectableTeam) => (team.isNsmAdmin ? '/favicon.svg' : `https://github.com/${team.login}.png?size=80`);

export default function TeamSwitcher({ onNavigate }: TeamSwitcherProps) {
    const navigate = useNavigate();
    const { selectedTeam, selectableTeams, setSelectedTeamId } = useSelectedTeam();

    const select = (team: SelectableTeam) => {
        setSelectedTeamId(team.ownerId);
        navigate(team.isNsmAdmin ? '/nodes' : '/');
        onNavigate?.();
    };

    if (selectableTeams.length === 0) {
        return (
            <Text fw={700} size="sm">
                No teams
            </Text>
        );
    }

    return (
        <Menu position="bottom-start" width={240} withinPortal>
            <Menu.Target>
                <UnstyledButton>
                    <Group gap={8} wrap="nowrap">
                        <Avatar src={selectedTeam ? teamAvatarSrc(selectedTeam) : undefined} size="sm" radius="sm" />
                        {selectedTeam?.team && !selectedTeam.team.installed && <MdOutlineWarningAmber color="var(--mantine-color-red-6)" />}
                        <Text fw={700} size="sm" truncate maw={160}>
                            {selectedTeam?.login ?? 'Select team'}
                        </Text>
                        <MdExpandMore />
                    </Group>
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
                <Menu.Label>Teams</Menu.Label>
                {selectableTeams.map((team) => {
                    const isSelected = team.ownerId === selectedTeam?.ownerId;
                    const uninstalled = !team.isNsmAdmin && team.team && !team.team.installed;
                    const isNsmSeparator = team.ownerId === NSM_TEAM_ID;
                    return (
                        <div key={team.ownerId}>
                            {isNsmSeparator && <Menu.Divider />}
                            <Menu.Item
                                leftSection={<Avatar src={teamAvatarSrc(team)} size="sm" radius="sm" />}
                                rightSection={isSelected ? <MdCheck /> : undefined}
                                onClick={() => select(team)}
                            >
                                <Group gap={6} wrap="nowrap">
                                    <Text size="sm" truncate>
                                        {team.login}
                                    </Text>
                                    {uninstalled && <MdOutlineWarningAmber color="var(--mantine-color-red-6)" />}
                                </Group>
                            </Menu.Item>
                        </div>
                    );
                })}
            </Menu.Dropdown>
        </Menu>
    );
}
