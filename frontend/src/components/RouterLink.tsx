import React, { useEffect } from 'react';
import { NavLink as MantineNavLink, NavLinkProps as MantineNavLinkProps } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

export interface RouterLinkProps extends MantineNavLinkProps {
    to: string;
    showActive?: boolean;
    children?: React.ReactNode;
}
export default function RouterLink(props: RouterLinkProps) {
    const navigate = useNavigate();
    let shape = props.to;
    if (props.children) {
        shape = `${props.to}/*`;
    }
    const active = !!(props.showActive && pathMatchesShape(window.location.pathname, shape));
    const [opened, setOpened] = React.useState<boolean>(pathMatchesShape(window.location.pathname, shape));
    useEffect(() => {
        setOpened(pathMatchesShape(window.location.pathname, shape));
    }, [window.location.pathname, shape, props.children]);
    return (
        <MantineNavLink
            onClickCapture={(e) => {
                e.preventDefault();
                navigate(props.to);
                setOpened(!opened);
            }}
            active={active}
            opened={opened}
            {...props}
        >
            {props.children}
        </MantineNavLink>
    );
}

const pathMatchesShape = (path: string, shape: string): boolean => {
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
