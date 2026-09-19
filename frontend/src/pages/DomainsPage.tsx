import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Center, Group, Loader, Modal, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { Capability, DomainRequest, DomainRequestStatus, DomainSearchResult } from '@mosaiq/nsm-common/types';
import { useNavigate } from 'react-router-dom';
import { useMe } from '@/hooks/queries/useMe';
import { useDomains } from '@/hooks/queries/useDomains';
import { useDomainRequests, useDomainBilling } from '@/hooks/queries/domainHooks';
import { useTeams } from '@/hooks/queries/teamHooks';
import { queryKeys } from '@/query/keys';
import { useDomainSearch, useCreateDomainRequest, useDecideDomainRequest, useCloudflareSync, usePublicIpRefresh } from '@/hooks/mutations/domainMutations';
import { MdOutlineCloudSync, MdOutlineRefresh, MdOutlineSearch, MdOutlineSync } from 'react-icons/md';

const requestStatusColor: Record<DomainRequestStatus, string> = {
    [DomainRequestStatus.PENDING]: 'yellow',
    [DomainRequestStatus.PURCHASING]: 'blue',
    [DomainRequestStatus.PURCHASED]: 'green',
    [DomainRequestStatus.DENIED]: 'gray',
    [DomainRequestStatus.FAILED]: 'red',
};

const DomainsPage = () => {
    const meCtx = useMe();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const domainsCtx = useDomains();
    const isAdmin = meCtx.isAdmin;
    const isSuperAdmin = meCtx.isSuperAdmin;
    const domains = domainsCtx.domains;

    const requestsQuery = useDomainRequests();
    const billingQuery = useDomainBilling(isAdmin);
    const teamsQuery = useTeams(isAdmin);
    const requests = requestsQuery.data ?? [];
    const billing = billingQuery.data ?? null;
    const teams = teamsQuery.data ?? [];

    const searchMutation = useDomainSearch();
    const createRequest = useCreateDomainRequest();
    const decideRequest = useDecideDomainRequest();
    const cloudflareSync = useCloudflareSync();
    const publicIpRefresh = usePublicIpRefresh();

    const loading = requestsQuery.isFetching || (isAdmin && (billingQuery.isFetching || teamsQuery.isFetching)) || !domainsCtx.ready;
    const syncingIp = publicIpRefresh.isPending;
    const syncingCf = cloudflareSync.isPending;
    const searching = searchMutation.isPending;
    const submitting = createRequest.isPending || decideRequest.isPending;

    // Search + request flow
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<DomainSearchResult[] | null>(null);
    const [pending, setPending] = useState<DomainSearchResult | null>(null);
    const [targetTeam, setTargetTeam] = useState<string | null>(null);

    const requestableTeams = meCtx.teams.filter((t) => t.installed && t.capabilities.includes(Capability.CREATE_PROJECT));

    const refresh = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.domainRequests() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.domainBilling() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.teams() }),
            domainsCtx.refresh(),
        ]);
    };

    const runSearch = async () => {
        if (!query.trim()) return;
        setResults(null);
        try {
            const res = await searchMutation.mutateAsync(query.trim());
            setResults(res ?? []);
        } catch {
            notifications.show({ color: 'red', message: 'Search failed. Cloudflare registrar may not be configured.' });
        }
    };

    // Non-super-admins can only target teams they can create projects in; the super admin (buying
    // directly) may allocate the domain to any installed team.
    const targetTeamOptions = isSuperAdmin ? teams.filter((t) => t.installed).map((t) => ({ value: t.ownerId, label: t.login })) : requestableTeams.map((t) => ({ value: t.ownerId, label: t.login }));

    const openRequest = (result: DomainSearchResult) => {
        setPending(result);
        setTargetTeam(targetTeamOptions[0]?.value ?? null);
    };

    const submitRequest = async () => {
        if (!pending || !targetTeam) return;
        try {
            const created = await createRequest.mutateAsync({ domainName: pending.name, ownerId: targetTeam, priceCurrency: pending.currency, priceRegistration: pending.registrationCost, priceRenewal: pending.renewalCost });
            // Super admins buy directly: create the request, then immediately approve it.
            if (isSuperAdmin) {
                notifications.show({ color: 'blue', message: `Purchasing ${pending.name}...` });
                await decideRequest.mutateAsync({ requestId: created.id, approve: true });
            } else {
                notifications.show({ color: 'green', message: `Requested ${pending.name}. The super admin has been notified.` });
            }
            setPending(null);
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Request failed.' });
        }
    };

    const runCloudflareSync = async () => {
        try {
            const res = await cloudflareSync.mutateAsync();
            if (res.ok) {
                notifications.show({ color: 'green', title: 'Cloudflare synced', message: `Synced ${res.zoneCount ?? 0} zone(s) from Cloudflare.` });
            } else {
                notifications.show({ color: 'red', title: 'Cloudflare sync failed', message: res.error || 'Sync failed.', autoClose: false });
            }
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Cloudflare sync failed.' });
        }
    };

    const syncPublicIp = async () => {
        try {
            const res = await publicIpRefresh.mutateAsync();
            if (res.changed) {
                notifications.show({ color: 'green', title: 'Dynamic DNS updated', message: `Public IP changed to ${res.ip}. Dynamic records were repushed to Cloudflare.` });
            } else {
                notifications.show({ color: 'blue', message: res.ip ? `Public IP unchanged (${res.ip}).` : 'No public IP detected.' });
            }
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Public IP refresh failed.' });
        }
    };

    const decide = async (req: DomainRequest, approve: boolean) => {
        let reason: string | undefined;
        if (!approve) {
            reason = window.prompt(`Reason for denying ${req.domainName}?`) || 'Denied';
        } else if (!window.confirm(`Approve and BUY ${req.domainName}? This spends real money and is non-refundable.`)) {
            return;
        }
        try {
            await decideRequest.mutateAsync({ requestId: req.id, approve, reason });
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Decision failed.' });
        }
    };

    if (loading && !domains.length && !requests.length) {
        return (
            <Center>
                <Loader />
            </Center>
        );
    }

    const price = (r: DomainSearchResult) => (r.registrationCost ? `${r.registrationCost} ${r.currency ?? ''}${r.renewalCost ? ` (renews ${r.renewalCost})` : ''}` : '—');

    return (
        <Stack>
            <Group justify="space-between" align="center">
                <Title order={3}>Domains</Title>
                <Group gap="xs" align="center">
                    {isAdmin && (
                        <Tooltip label="Re-sync zones, DNS records and domains from Cloudflare now">
                            <Button variant="light" leftSection={<MdOutlineCloudSync />} onClick={runCloudflareSync} loading={syncingCf}>
                                Sync Cloudflare
                            </Button>
                        </Tooltip>
                    )}
                    {isAdmin && (
                        <Tooltip label="Check the public IP now and repush dynamic-IP DNS records if it changed">
                            <Button variant="light" leftSection={<MdOutlineSync />} onClick={syncPublicIp} loading={syncingIp}>
                                Sync public IP
                            </Button>
                        </Tooltip>
                    )}
                    <Tooltip label="Refresh">
                        <ActionIcon variant="light" size="lg" onClick={refresh} loading={loading}>
                            <MdOutlineRefresh />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>

            {/* Search + request/buy */}
            <Card withBorder>
                <Stack>
                    <Title order={5}>Find a domain</Title>
                    <Group>
                        <TextInput
                            flex={1}
                            placeholder="mycoolproject.com"
                            value={query}
                            onChange={(e) => setQuery(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                            leftSection={<MdOutlineSearch />}
                        />
                        <Button onClick={runSearch} loading={searching} disabled={!query.trim()}>
                            Search
                        </Button>
                    </Group>
                    {requestableTeams.length === 0 && !isSuperAdmin && (
                        <Alert color="yellow" variant="light">
                            You need the Create Project capability on a team to request a domain.
                        </Alert>
                    )}
                    {results && (
                        <Table verticalSpacing="xs" fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Domain</Table.Th>
                                    <Table.Th>Availability</Table.Th>
                                    <Table.Th>Price</Table.Th>
                                    <Table.Th />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {results.map((r) => (
                                    <Table.Tr key={r.name}>
                                        <Table.Td>{r.name}</Table.Td>
                                        <Table.Td>
                                            {r.registrable ? <Badge color="green" variant="light">available</Badge> : <Badge color="gray" variant="light">{r.reason || 'unavailable'}</Badge>}
                                            {r.tier === 'premium' && <Badge ml={4} color="grape" variant="light">premium</Badge>}
                                        </Table.Td>
                                        <Table.Td>{price(r)}</Table.Td>
                                        <Table.Td align="right">
                                            {r.registrable && r.tier !== 'premium' && (requestableTeams.length > 0 || isSuperAdmin) && (
                                                <Button size="compact-sm" variant="light" onClick={() => openRequest(r)}>
                                                    {isSuperAdmin ? 'Buy' : 'Request'}
                                                </Button>
                                            )}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                                {results.length === 0 && (
                                    <Table.Tr>
                                        <Table.Td colSpan={4}>
                                            <Text c="dimmed" fz="sm">No suggestions.</Text>
                                        </Table.Td>
                                    </Table.Tr>
                                )}
                            </Table.Tbody>
                        </Table>
                    )}
                </Stack>
            </Card>

            {/* Requests queue */}
            {requests.length > 0 && (
                <Card withBorder>
                    <Stack>
                        <Title order={5}>{isSuperAdmin ? 'Purchase requests' : 'My requests'}</Title>
                        <Table verticalSpacing="xs" fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Domain</Table.Th>
                                    <Table.Th>Requester</Table.Th>
                                    <Table.Th>Team</Table.Th>
                                    <Table.Th>Price</Table.Th>
                                    <Table.Th>Status</Table.Th>
                                    <Table.Th />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {requests.map((req) => (
                                    <Table.Tr key={req.id}>
                                        <Table.Td>{req.domainName}</Table.Td>
                                        <Table.Td>{req.requesterLogin}</Table.Td>
                                        <Table.Td>{req.ownerLogin ?? '—'}</Table.Td>
                                        <Table.Td>{req.priceRegistration ? `${req.priceRegistration} ${req.priceCurrency ?? ''}` : '—'}</Table.Td>
                                        <Table.Td>
                                            <Badge color={requestStatusColor[req.status]} variant="light">
                                                {req.status}
                                            </Badge>
                                            {req.reason && req.status !== DomainRequestStatus.PURCHASED && (
                                                <Text fz="xs" c="dimmed">
                                                    {req.reason}
                                                </Text>
                                            )}
                                        </Table.Td>
                                        <Table.Td align="right">
                                            {isSuperAdmin && req.status === DomainRequestStatus.PENDING && (
                                                <Group gap={4} justify="flex-end">
                                                    <Button size="compact-sm" color="green" onClick={() => decide(req, true)}>
                                                        Approve & Buy
                                                    </Button>
                                                    <Button size="compact-sm" variant="light" color="red" onClick={() => decide(req, false)}>
                                                        Deny
                                                    </Button>
                                                </Group>
                                            )}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Stack>
                </Card>
            )}

            {/* Owned domains table (admin) */}
            {isAdmin && (
                <Card withBorder>
                    <Stack>
                        <Title order={5}>Owned domains</Title>
                        <Text fz="xs" c="dimmed">
                            Click a domain to manage DNS records, allocations, and billing.
                        </Text>
                        <Table verticalSpacing="xs" highlightOnHover fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Domain</Table.Th>
                                    <Table.Th>Status</Table.Th>
                                    <Table.Th>Records</Table.Th>
                                    <Table.Th>Teams</Table.Th>
                                    <Table.Th>Expiry</Table.Th>
                                    <Table.Th>Renewal</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {domains.map((z) => (
                                    <Table.Tr key={z.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/domains/${z.id}`)}>
                                        <Table.Td fw={600}>{z.name}</Table.Td>
                                        <Table.Td>
                                            <Badge color={z.status === 'active' ? 'green' : 'yellow'} variant="light">
                                                {z.status}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>{z.recordCount ?? 0}</Table.Td>
                                        <Table.Td>{z.allocatedTeamIds?.length ?? 0}</Table.Td>
                                        <Table.Td>{z.billing?.expiresAt ? new Date(z.billing.expiresAt).toLocaleDateString() : '—'}</Table.Td>
                                        <Table.Td>{z.billing?.renewalCost ? `${z.billing.renewalCost} ${z.billing.currency ?? ''}` : '—'}</Table.Td>
                                    </Table.Tr>
                                ))}
                                {domains.length === 0 && (
                                    <Table.Tr>
                                        <Table.Td colSpan={6}>
                                            <Text c="dimmed" fz="sm">
                                                No domains yet. If Cloudflare is configured, domains will appear here after the next sync.
                                            </Text>
                                        </Table.Td>
                                    </Table.Tr>
                                )}
                            </Table.Tbody>
                        </Table>
                    </Stack>
                </Card>
            )}

            {/* Billing summary (admin) */}
            {isAdmin && billing && billing.totalsByCurrency.length > 0 && (
                <Card withBorder>
                    <Stack gap="xs">
                        <Title order={5}>Billing estimate</Title>
                        {billing.totalsByCurrency.map((t) => (
                            <Text key={t.currency} fz="sm">
                                {t.currency}: ~{t.monthly.toFixed(2)}/mo (~{t.yearly.toFixed(2)}/yr) across renewals
                            </Text>
                        ))}
                        <Text fz="xs" c="dimmed">
                            Estimates use known renewal prices; domains added outside NSM may not report a price.
                        </Text>
                    </Stack>
                </Card>
            )}

            {/* Request/Buy target-team modal */}
            <Modal opened={!!pending} onClose={() => setPending(null)} title={<Title order={4}>{isSuperAdmin ? 'Buy domain' : 'Request domain'}</Title>}>
                {pending && (
                    <Stack>
                        <Text>
                            {pending.name} — {price(pending)}
                        </Text>
                        {isSuperAdmin && (
                            <Alert color="red" variant="light">
                                Buying registers the domain immediately and is non-refundable.
                            </Alert>
                        )}
                        <Select label="Allocate to team" data={targetTeamOptions} value={targetTeam} onChange={setTargetTeam} placeholder="Select a team" searchable />
                        {targetTeamOptions.length === 0 && (
                            <Alert color="yellow" variant="light">
                                No installed team is available to allocate this domain to.
                            </Alert>
                        )}
                        <Group justify="flex-end">
                            <Button variant="subtle" onClick={() => setPending(null)} disabled={submitting}>
                                Cancel
                            </Button>
                            <Button onClick={submitRequest} loading={submitting} disabled={!targetTeam} color={isSuperAdmin ? 'red' : undefined}>
                                {isSuperAdmin ? 'Buy now' : 'Submit request'}
                            </Button>
                        </Group>
                    </Stack>
                )}
            </Modal>
        </Stack>
    );
};

export default DomainsPage;
