import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Alert, Box, Button, Group, NavLink as MantineNavLink, Stack, Text } from '@mantine/core';
import { MdChevronLeft, MdOutlineWarningAmber } from 'react-icons/md';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMe } from '@/hooks/queries/useMe';
import { useSelectedTeam } from '@/contexts/selected-team-context';
import { pathMatchesShape } from '@/components/RouterLink';
import { ProjectStatusChip } from '@/components/ProjectStatusChip';
import { deriveSidebarStack, SidebarLevel } from './sidebarModel';

const ANIMATION_MS = 240;

// Keyframes for the drill-in/out slide. Injected once; forward = going deeper (new list slides in
// from the right), back = returning (new list slides in from the left).
const slideStyles = `
@keyframes nsm-sidebar-in-right { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes nsm-sidebar-out-left { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-40%); opacity: 0; } }
@keyframes nsm-sidebar-in-left { from { transform: translateX(-100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes nsm-sidebar-out-right { from { transform: translateX(0); opacity: 1; } to { transform: translateX(40%); opacity: 0; } }
`;

interface SidebarProps {
    // Opens the Create Project modal for the given owner login.
    onCreateProject: (ownerLogin: string) => void;
    // Called after any navigation (used to close the mobile navbar).
    onNavigate?: () => void;
}

export default function Sidebar({ onCreateProject, onNavigate }: SidebarProps) {
    const location = useLocation();
    const navigate = useNavigate();
    const meCtx = useMe();
    const { selectedTeam } = useSelectedTeam();

    const stack = deriveSidebarStack({ pathname: location.pathname, selectedTeam, isAdmin: meCtx.isAdmin, canProject: meCtx.canProject });
    const current = stack[stack.length - 1] ?? null;

    const [anim, setAnim] = useState<{ out: SidebarLevel; dir: 'forward' | 'back' } | null>(null);
    const prevRef = useRef<{ level: SidebarLevel; depth: number } | null>(null);

    useEffect(() => {
        if (!current) return;
        const prev = prevRef.current;
        if (prev && prev.level.key !== current.key) {
            const dir: 'forward' | 'back' = current.depth >= prev.depth ? 'forward' : 'back';
            setAnim({ out: prev.level, dir });
            prevRef.current = { level: current, depth: current.depth };
            const timer = setTimeout(() => setAnim(null), ANIMATION_MS);
            return () => clearTimeout(timer);
        }
        prevRef.current = { level: current, depth: current.depth };
    }, [current?.key, current?.depth]);

    if (!current) return null;

    const go = (to: string) => {
        navigate(to);
        onNavigate?.();
    };

    const renderLevel = (level: SidebarLevel) => {
        const team = selectedTeam?.team;
        const showInstallWarning = level.depth === 0 && team && !team.installed;
        return (
            <Stack gap={4} h="100%" style={{ overflowY: 'auto' }}>
                <Group gap={6} wrap="nowrap" mb={4} align="center">
                    {level.backTo && (
                        <ActionIcon variant="subtle" color="gray" aria-label="Back" onClick={() => go(level.backTo!)}>
                            <MdChevronLeft size={20} />
                        </ActionIcon>
                    )}
                    <Text fw={700} size="sm" truncate>
                        {level.title}
                    </Text>
                </Group>

                {showInstallWarning && (
                    <Alert color="red" variant="light" icon={<MdOutlineWarningAmber />} p="xs">
                        <Text size="xs">The NSM GitHub App is not installed on this team. Reinstall it to deploy projects.</Text>
                    </Alert>
                )}

                {level.items.map((item) => {
                    const active = pathMatchesShape(location.pathname, item.activeShape ?? item.to);
                    return (
                        <MantineNavLink
                            key={item.key}
                            label={item.label}
                            active={active}
                            onClick={() => go(item.to)}
                            rightSection={item.statusProjectId ? <ProjectStatusChip projectId={item.statusProjectId} /> : undefined}
                        />
                    );
                })}

                {level.items.length === 0 && !showInstallWarning && (
                    <Text size="xs" c="dimmed" px="xs" py={4}>
                        No projects yet.
                    </Text>
                )}

                {level.createProjectOwnerLogin && (
                    <Button variant="subtle" size="xs" mt="xs" onClick={() => onCreateProject(level.createProjectOwnerLogin!)}>
                        Create Project
                    </Button>
                )}
            </Stack>
        );
    };

    const inAnimation = anim
        ? anim.dir === 'forward'
            ? 'nsm-sidebar-in-right'
            : 'nsm-sidebar-in-left'
        : undefined;
    const outAnimation = anim ? (anim.dir === 'forward' ? 'nsm-sidebar-out-left' : 'nsm-sidebar-out-right') : undefined;

    return (
        <Box style={{ position: 'relative', overflow: 'hidden', flex: 1, minHeight: 0 }}>
            <style>{slideStyles}</style>
            {anim && (
                <Box
                    key={anim.out.key}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        animation: `${outAnimation} ${ANIMATION_MS}ms ease forwards`,
                        pointerEvents: 'none',
                    }}
                >
                    {renderLevel(anim.out)}
                </Box>
            )}
            <Box
                key={current.key}
                style={{
                    position: anim ? 'absolute' : 'relative',
                    inset: anim ? 0 : undefined,
                    height: '100%',
                    animation: inAnimation ? `${inAnimation} ${ANIMATION_MS}ms ease forwards` : undefined,
                }}
            >
                {renderLevel(current)}
            </Box>
        </Box>
    );
}
