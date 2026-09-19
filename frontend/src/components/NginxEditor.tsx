import { ActionIcon, Autocomplete, Button, Group, Stack, Title, Text, Switch, Textarea, TextInput, Menu, Tooltip, Fieldset, Space, NumberInput, Badge, SegmentedControl } from '@mantine/core';
import { ConfigLocation, NginxConfigLocationType, Project, ProjectNginxConfig } from '@mosaiq/nsm-common/types';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import React, { useEffect, useState } from 'react';
import { MdOutlineCheckCircle, MdOutlineCode, MdOutlineDelete, MdOutlineDns, MdOutlineLink, MdOutlineWeb } from 'react-icons/md';
import { useAPI } from '@/utils/api';

// A human-readable summary of what a route serves, shown in place of its UUID.
const locationSummary = (location: ConfigLocation): string => {
    switch (location.type) {
        case NginxConfigLocationType.STATIC:
            return location.spa ? '/ (SPA)' : location.path || '/';
        case NginxConfigLocationType.REDIRECT:
            return `${location.path || '/'} -> ${location.target || '...'}`;
        case NginxConfigLocationType.PROXY:
        case NginxConfigLocationType.CUSTOM:
        default:
            return location.path || '/';
    }
};

interface NginxEditorProps {
    current: ProjectNginxConfig;
    onSave: (config: ProjectNginxConfig) => void;
    project: Project;
}
export const NginxEditor = (props: NginxEditorProps) => {
    const api = useAPI();
    const [config, setConfig] = useState<ProjectNginxConfig>(JSON.parse(JSON.stringify(props.current)));
    // Domains allocated to this project's team, offered in the domain picker. Free text is still
    // allowed; a typed value that matches an allocated domain auto-links.
    const [knownDomains, setKnownDomains] = useState<string[]>([]);

    useEffect(() => {
        if (!props.project?.id) return;
        let cancelled = false;
        void api.get(API_ROUTES.GET_PROJECT_DOMAINS, { projectId: props.project.id }).then((res) => {
            if (!cancelled && res) setKnownDomains(res);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.project?.id, api.token]);

    useEffect(() => {
        const json = JSON.stringify(props.current);
        const curr = JSON.stringify(config);
        if (json !== curr) setConfig(JSON.parse(json));
    }, [props.current]);

    useEffect(() => {
        const oldConfig = JSON.stringify(props.current);
        const newConfig = JSON.stringify(config);
        if (oldConfig !== newConfig) {
            props.onSave(JSON.parse(newConfig));
        }
    }, [config]);

    const handleAddServer = () => {
        const newServer: ProjectNginxConfig['servers'][number] = {
            serverId: crypto.randomUUID(),
            domain: '',
            wildcardSubdomain: false,
            locations: [],
        };
        setConfig({ ...config, servers: [...config.servers, newServer] });
    };

    const handleAddLocation = (serverIndex: number, locationType: NginxConfigLocationType) => {
        let newLocation: ConfigLocation;
        switch (locationType) {
            case NginxConfigLocationType.STATIC:
                newLocation = {
                    locationId: crypto.randomUUID(),
                    type: NginxConfigLocationType.STATIC,
                    path: '/',
                    serveDir: '',
                    spa: false,
                    explicitCors: false,
                };
                break;
            case NginxConfigLocationType.PROXY:
                newLocation = {
                    locationId: crypto.randomUUID(),
                    type: NginxConfigLocationType.PROXY,
                    path: '/',
                    proxyPass: '',
                    timeout: undefined,
                    maxClientBodySizeMb: undefined,
                    websocketSupport: false,
                    replications: 1,
                };
                break;
            case NginxConfigLocationType.REDIRECT:
                newLocation = {
                    locationId: crypto.randomUUID(),
                    type: NginxConfigLocationType.REDIRECT,
                    path: '/',
                    target: '',
                };
                break;
            case NginxConfigLocationType.CUSTOM:
                newLocation = {
                    locationId: crypto.randomUUID(),
                    type: NginxConfigLocationType.CUSTOM,
                    path: '/',
                    content: '',
                };
        }
        setConfig((prevConfig) => ({
            ...prevConfig,
            servers: prevConfig.servers.map((srv, idx) => (idx === serverIndex ? { ...srv, locations: [...srv.locations, newLocation] } : srv)),
        }));
    };

    const handleRemoveLocation = (serverId: string, locationId: string) => {
        setConfig((prevConfig) => ({
            ...prevConfig,
            servers: prevConfig.servers.map((srv) => (srv.serverId === serverId ? { ...srv, locations: srv.locations.filter((loc) => loc.locationId !== locationId) } : srv)),
        }));
    };

    const handleRemoveServer = (serverId: string) => {
        setConfig((prevConfig) => ({
            ...prevConfig,
            servers: prevConfig.servers.filter((srv) => srv.serverId !== serverId),
        }));
    };

    const MenuItems = {
        [NginxConfigLocationType.CUSTOM]: { icon: MdOutlineCode, desc: 'Custom location block', title: 'Custom NGINX Block' },
        [NginxConfigLocationType.REDIRECT]: { icon: MdOutlineLink, desc: 'Redirect requests to another URL', title: 'Redirect Link' },
        [NginxConfigLocationType.PROXY]: { icon: MdOutlineDns, desc: 'Proxy requests to another server', title: 'API Service' },
        [NginxConfigLocationType.STATIC]: { icon: MdOutlineWeb, desc: 'Serve static files from a directory', title: 'Static Page' },
    };

    const duplicateDomain = config.servers.map((srv) => srv.domain).find((domain, idx, arr) => arr.indexOf(domain) !== idx);
    return (
        <Stack>
            <Title order={5}>Sites & Routing</Title>
            {config.servers.map((server, serverIndex) => {
                const duplicatePath = server.locations.map((loc) => loc.path).find((path, idx, arr) => arr.indexOf(path) !== idx);
                return (
                    <Fieldset key={server.serverId}>
                        <Title order={5}>{server.domain || 'New Site'}</Title>
                        <Group justify="space-between" align="flex-end" gap="xl">
                            <Group align="flex-end">
                                <DomainPicker
                                    value={server.domain}
                                    knownDomains={knownDomains}
                                    error={duplicateDomain === server.domain ? 'Duplicate Domain' : undefined}
                                    onChange={(fullDomain) => {
                                        const newServers = [...config.servers];
                                        newServers[serverIndex].domain = fullDomain;
                                        setConfig({ ...config, servers: newServers });
                                    }}
                                />
                                <Switch
                                    label="Wildcard"
                                    description={`Capture all subdomains? ( *.${server.domain} -> ${server.domain} )`}
                                    checked={server.wildcardSubdomain}
                                    onChange={(event) => {
                                        const newServers = [...config.servers];
                                        newServers[serverIndex].wildcardSubdomain = event.currentTarget.checked;
                                        setConfig({ ...config, servers: newServers });
                                    }}
                                />
                            </Group>
                            <Tooltip label={`Remove ${server.domain || 'this site'}`}>
                                <ActionIcon onClick={() => handleRemoveServer(server.serverId)} variant="light" color="red" size={'input-sm'}>
                                    <MdOutlineDelete />
                                </ActionIcon>
                            </Tooltip>
                        </Group>
                        <Space h="md" />
                        <Text>Routes:</Text>
                        <Space h="xs" />
                        <Group wrap="wrap" align="flex-start">
                            {server.locations.map((location, locationIndex) => {
                                return (
                                    <Fieldset key={location.locationId}>
                                        <Stack w="300px" gap="xs">
                                            <Group justify="space-between" align="center" wrap="nowrap">
                                                <Group gap="xs" wrap="nowrap">
                                                    <Badge leftSection={MenuItems[location.type].icon({ size: 14 })} variant="outline">
                                                        {MenuItems[location.type].title}
                                                    </Badge>
                                                    <Text fw={600} truncate>
                                                        {locationSummary(location)}
                                                    </Text>
                                                </Group>
                                                <Tooltip label={`Remove ${MenuItems[location.type].title}`}>
                                                    <ActionIcon onClick={() => handleRemoveLocation(server.serverId, location.locationId)} variant="light" color="red" size={'input-xs'}>
                                                        <MdOutlineDelete />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Group>
                                            <RenderLocation
                                                location={location}
                                                domain={server.domain}
                                                onChange={(updatedLocation) => {
                                                    setConfig((prevConfig) => {
                                                        const newLocations = [...prevConfig.servers[serverIndex].locations];
                                                        newLocations[locationIndex] = updatedLocation;
                                                        const newServers = [...prevConfig.servers];
                                                        newServers[serverIndex].locations = newLocations;
                                                        return { ...prevConfig, servers: newServers };
                                                    });
                                                }}
                                                duplicatePath={duplicatePath === location.path}
                                                spaTakenByOther={server.locations.some((l) => l.locationId !== location.locationId && l.type === NginxConfigLocationType.STATIC && l.spa)}
                                            />
                                        </Stack>
                                    </Fieldset>
                                );
                            })}
                            <Menu withArrow shadow="md" trigger={'hover'}>
                                <Menu.Target>
                                    <Button variant="light" w="min-content" size="compact-sm">
                                        Add Route
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Stack p="xs">
                                        {Object.entries(MenuItems).map(([key, value]) => (
                                            <Menu.Item key={key} leftSection={<value.icon size={24} />} onClick={() => handleAddLocation(serverIndex, key as NginxConfigLocationType)}>
                                                <Title order={6}>{MenuItems[key as NginxConfigLocationType].title}</Title>
                                                <Text fz=".75rem">{value.desc}</Text>
                                            </Menu.Item>
                                        ))}
                                    </Stack>
                                </Menu.Dropdown>
                            </Menu>
                        </Group>
                    </Fieldset>
                );
            })}
            <Button onClick={handleAddServer} w="min-content" disabled={config.servers.length >= 26}>
                Add a Domain
            </Button>
        </Stack>
    );
};

// Split a full domain into a subdomain + base domain, preferring the longest allocated domain that
// the value is (a subdomain of). Falls back to treating the whole value as the base domain.
const splitDomain = (full: string, known: string[]): { sub: string; base: string } => {
    const f = (full || '').toLowerCase();
    const match = known
        .filter((k) => f === k.toLowerCase() || f.endsWith(`.${k.toLowerCase()}`))
        .sort((a, b) => b.length - a.length)[0];
    if (match) {
        if (f === match.toLowerCase()) return { sub: '', base: match };
        return { sub: full.slice(0, full.length - match.length - 1), base: match };
    }
    return { sub: '', base: full };
};

const composeDomain = (sub: string, base: string): string => {
    const s = sub.trim();
    const b = base.trim();
    return s ? `${s}.${b}` : b;
};

interface DomainPickerProps {
    value: string;
    knownDomains: string[];
    error?: string;
    onChange: (fullDomain: string) => void;
}

// Replaces the free-text domain box with a `[subdomain].[known-domain]` picker. The base domain is
// an Autocomplete over the team's allocated domains (free text allowed); a value that matches an
// allocated domain shows a "linked" check.
const DomainPicker = (props: DomainPickerProps) => {
    const initial = splitDomain(props.value, props.knownDomains);
    const [sub, setSub] = useState(initial.sub);
    const [base, setBase] = useState(initial.base);

    // Resync from the external value when it changes to something we didn't just compose.
    useEffect(() => {
        if (composeDomain(sub, base) !== props.value) {
            const s = splitDomain(props.value, props.knownDomains);
            setSub(s.sub);
            setBase(s.base);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.value]);

    // Re-link once allocated domains load (a base previously treated as free text may now match).
    useEffect(() => {
        const s = splitDomain(composeDomain(sub, base), props.knownDomains);
        setSub(s.sub);
        setBase(s.base);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.knownDomains.length]);

    const update = (nextSub: string, nextBase: string) => {
        setSub(nextSub);
        setBase(nextBase);
        props.onChange(composeDomain(nextSub, nextBase));
    };

    const isLinked = props.knownDomains.some((k) => k.toLowerCase() === base.trim().toLowerCase());

    return (
        <Group gap={4} align="flex-end">
            <TextInput label="Subdomain" placeholder="api" value={sub} onChange={(e) => update(e.currentTarget.value, base)} w={110} />
            <Text pb={8} fw={700}>
                .
            </Text>
            <Autocomplete
                required
                label="Domain"
                placeholder="example.com"
                data={props.knownDomains}
                value={base}
                onChange={(v) => update(sub, v)}
                error={props.error}
                rightSection={isLinked ? <MdOutlineCheckCircle color="var(--mantine-color-green-6)" /> : undefined}
                w={240}
            />
        </Group>
    );
};

interface RenderLocationProps {
    location: ConfigLocation;
    domain: string;
    onChange: (location: ConfigLocation) => void;
    duplicatePath: boolean;
    // True when another static route on the same site already occupies the single-page-app slot, so
    // this route cannot also be an SPA (two SPAs would fight over the `/` route).
    spaTakenByOther: boolean;
}

const RenderLocation = (props: RenderLocationProps) => {
    if (props.location.type === NginxConfigLocationType.STATIC) {
        const isSpa = !!props.location.spa;
        return (
            <>
                <SegmentedControl
                    fullWidth
                    value={isSpa ? 'spa' : 'files'}
                    onChange={(val) => {
                        if (props.location.type !== NginxConfigLocationType.STATIC) return;
                        const nextSpa = val === 'spa';
                        props.onChange({ ...props.location, spa: nextSpa, path: nextSpa ? '/' : props.location.path });
                    }}
                    data={[
                        { label: 'Single-Page App', value: 'spa', disabled: props.spaTakenByOther && !isSpa },
                        { label: 'Static Files', value: 'files' },
                    ]}
                />
                {props.spaTakenByOther && !isSpa && (
                    <Text fz="xs" c="dimmed">
                        Only one single-page app is allowed per site.
                    </Text>
                )}
                {isSpa ? (
                    <TextInput required value="/" label="Path" description={props.domain ? `https://${props.domain}` : 'Served at the site root'} readOnly />
                ) : (
                    <TextInput
                        required
                        value={props.location.path}
                        label="Path"
                        placeholder="/"
                        description={props.domain && props.location.path.startsWith('/') ? `https://${props.domain}${props.location.path}` : ''}
                        onChange={(e) => props.location.type === NginxConfigLocationType.STATIC && props.onChange({ ...props.location, path: e.currentTarget.value })}
                        error={props.duplicatePath ? 'Duplicate Path' : undefined}
                    />
                )}
                <Switch
                    label="Force Allow CORS"
                    description="Explicitly allow CORS for this location. Use with caution."
                    checked={!!props.location.explicitCors}
                    onChange={(e) => props.location.type === NginxConfigLocationType.STATIC && props.onChange({ ...props.location, explicitCors: e.currentTarget.checked })}
                />
            </>
        );
    }
    if (props.location.type === NginxConfigLocationType.PROXY) {
        return (
            <>
                <TextInput
                    required
                    value={props.location.path}
                    label="Path"
                    placeholder="/"
                    description={props.domain && props.location.path.startsWith('/') ? `https://${props.domain}${props.location.path}` : ''}
                    onChange={(e) => props.location.type === NginxConfigLocationType.PROXY && props.onChange({ ...props.location, path: e.currentTarget.value })}
                    error={props.duplicatePath ? 'Duplicate Path' : undefined}
                />
                <NumberInput
                    value={props.location.timeout}
                    label="Timeout (ms)"
                    placeholder="60sec default"
                    min={0}
                    max={1000 * 60 * 60}
                    description="The timeout for the proxy connection."
                    onChange={(e) => {
                        if (props.location.type !== NginxConfigLocationType.PROXY) return;
                        if (e === '') {
                            props.onChange({ ...props.location, timeout: undefined });
                            return;
                        }
                        const value = Number(e);
                        if (!isNaN(value)) {
                            props.onChange({ ...props.location, timeout: value });
                        }
                    }}
                />
                <NumberInput
                    value={props.location.maxClientBodySizeMb}
                    label="Max Client Body Size (MB)"
                    min={0}
                    max={1000 * 1000}
                    placeholder="10mb default"
                    description="The maximum allowed size of the client request body."
                    onChange={(e) => {
                        if (props.location.type !== NginxConfigLocationType.PROXY) return;
                        if (e === '') {
                            props.onChange({ ...props.location, maxClientBodySizeMb: undefined });
                            return;
                        }
                        const value = Number(e);
                        if (!isNaN(value)) {
                            props.onChange({ ...props.location, maxClientBodySizeMb: value });
                        }
                    }}
                />
                <Switch
                    label="Support WebSockets"
                    checked={!!props.location.websocketSupport}
                    onChange={(e) => props.location.type === NginxConfigLocationType.PROXY && props.onChange({ ...props.location, websocketSupport: e.currentTarget.checked })}
                />
            </>
        );
    }
    if (props.location.type === NginxConfigLocationType.REDIRECT) {
        return (
            <>
                <TextInput
                    required
                    value={props.location.path}
                    label="Path"
                    placeholder="/"
                    description={props.domain && props.location.path.startsWith('/') ? `https://${props.domain}${props.location.path}` : ''}
                    onChange={(e) => props.location.type === NginxConfigLocationType.REDIRECT && props.onChange({ ...props.location, path: e.currentTarget.value })}
                    error={props.duplicatePath ? 'Duplicate Path' : undefined}
                />
                <TextInput
                    required
                    value={props.location.target}
                    label="Redirects To"
                    placeholder="https://example.com"
                    onChange={(e) => props.location.type === NginxConfigLocationType.REDIRECT && props.onChange({ ...props.location, target: e.currentTarget.value })}
                />
            </>
        );
    }
    if (props.location.type === NginxConfigLocationType.CUSTOM) {
        return (
            <>
                <TextInput
                    required
                    value={props.location.path}
                    label="Path"
                    placeholder="/"
                    description={props.domain && props.location.path.startsWith('/') ? `https://${props.domain}${props.location.path}` : ''}
                    onChange={(e) => props.location.type === NginxConfigLocationType.CUSTOM && props.onChange({ ...props.location, path: e.currentTarget.value })}
                    error={props.duplicatePath ? 'Duplicate Path' : undefined}
                />
                <Textarea
                    required
                    value={props.location.content}
                    label="Content"
                    description="Location scope directives"
                    placeholder={`proxy_pass http://localhost:3000;`}
                    onChange={(e) => props.location.type === NginxConfigLocationType.CUSTOM && props.onChange({ ...props.location, content: e.currentTarget.value })}
                />
            </>
        );
    }
    return null;
};
