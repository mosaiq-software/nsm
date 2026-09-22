import React, { useEffect } from 'react';
import { Box, Group, NavLink as MantineNavLink, NavLinkProps as MantineNavLinkProps } from '@mantine/core';
import { MdChevronRight } from 'react-icons/md';
import { useLocation, useNavigate } from 'react-router-dom';

export interface RouterLinkProps extends MantineNavLinkProps {
    to: string;
    showActive?: boolean;
    activeWithin?: boolean;
    onNavigate?: () => void;
    children?: React.ReactNode;
}
export default function RouterLink(props: RouterLinkProps) {
    const navigate = useNavigate();
    const location = useLocation();
    const { to, showActive, activeWithin, onNavigate, children, rightSection, ...rest } = props;
    const shape = children ? `${to}/*` : to;
    const selfActive = pathMatchesShape(location.pathname, shape);
    const active = !!(showActive && selfActive);
    const activeHere = selfActive || !!activeWithin;
    const [opened, setOpened] = React.useState<boolean>(activeHere);
    useEffect(() => {
        if (activeHere) {
            setOpened(true);
        }
    }, [activeHere]);
    const composedRightSection =
        children || rightSection ? (
            <Group gap={6} wrap="nowrap">
                {rightSection}
                {children && (
                    <Box
                        component="span"
                        aria-label="Toggle section"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpened((o) => !o);
                        }}
                        style={{
                            display: 'flex',
                            cursor: 'pointer',
                            transition: 'transform 150ms ease',
                            transform: opened ? 'rotate(90deg)' : 'none',
                        }}
                    >
                        <MdChevronRight />
                    </Box>
                )}
            </Group>
        ) : undefined;
    return (
        <MantineNavLink
            onClick={(e) => {
                e.preventDefault();
                navigate(to);
                onNavigate?.();
            }}
            active={active}
            opened={children ? opened : undefined}
            disableRightSectionRotation
            rightSection={composedRightSection}
            {...rest}
        >
            {children}
        </MantineNavLink>
    );
}

export const pathMatchesShape = (path: string, shape: string): boolean => {
    if (shape === path || shape === '*') {
        return true;
    }

    path = path.split('?')[0];
    shape = shape.split('?')[0];

    path = path.split('#')[0];
    shape = shape.split('#')[0];

    path = path.replace('http://', '');
    path = path.replace('https://', '');
    shape = shape.replace('http://', '');
    shape = shape.replace('https://', '');

    const firstBlock = path.split('/')[0];
    if (firstBlock.includes('.') || (firstBlock.includes(':') && !firstBlock.startsWith(':'))) {
        path = path.split('/').slice(1).join('/');
    }

    path = path.endsWith('/') ? path.slice(0, -1) : path;
    shape = shape.endsWith('/') ? shape.slice(0, -1) : shape;

    path = path.startsWith('/') ? path.slice(1) : path;
    shape = shape.startsWith('/') ? shape.slice(1) : shape;

    const shapeParts = shape.split('/');
    const pathParts = path.split('/');

    for (let i = 0; i < Math.max(pathParts.length, shapeParts.length); i++) {
        if (shapeParts.length <= i) {
            return false;
        }
        if (shapeParts[i] === '*') {
            return true;
        }
        if (shapeParts[i].startsWith(':')) {
            continue;
        }
        if (pathParts.length <= i) {
            return false;
        }
        if (shapeParts[i] !== pathParts[i]) {
            return false;
        }
    }

    return true;
};
