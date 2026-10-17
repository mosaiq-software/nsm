import { Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { MdCheck, MdExpandMore, MdOutlineShield, MdOutlineWarningAmber } from 'react-icons/md';
import { useNavigate } from 'react-router-dom';
import { NSM_TEAM_ID, SelectableTeam, useSelectedTeam } from '@/contexts/selected-team-context';

interface TeamSwitcherProps {
    onNavigate?: () => void;
}

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
                    <Group gap={6} wrap="nowrap">
                        {selectedTeam?.isNsmAdmin && <MdOutlineShield />}
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
                                leftSection={team.isNsmAdmin ? <MdOutlineShield /> : uninstalled ? <MdOutlineWarningAmber color="var(--mantine-color-red-6)" /> : undefined}
                                rightSection={isSelected ? <MdCheck /> : undefined}
                                onClick={() => select(team)}
                            >
                                {team.login}
                            </Menu.Item>
                        </div>
                    );
                })}
            </Menu.Dropdown>
        </Menu>
    );
}
