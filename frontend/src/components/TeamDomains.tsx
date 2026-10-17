import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Group, Modal, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useNavigate } from 'react-router-dom';
import { Capability, DomainRequest, DomainRequestStatus, DomainSearchResult, REGISTRAR_PROVIDER_SPECS } from '@mosaiq/nsm-common/types';
import { useMe } from '@/hooks/queries/useMe';
import { useTeamDomains, useTeamDomainRequests, useTeamDomainBilling, useTeamRegistrar } from '@/hooks/queries/domainHooks';
import { useTeamDomainSearch, useBuyTeamDomain, useRequestTeamDomain, useDecideTeamDomainRequest, useTeamCloudflareSync } from '@/hooks/mutations/domainMutations';
import { MdOutlineCloudSync, MdOutlineRefresh, MdOutlineSearch } from 'react-icons/md';

const requestStatusColor: Record<DomainRequestStatus, string> = {
    [DomainRequestStatus.PENDING]: 'yellow',
    [DomainRequestStatus.PURCHASING]: 'blue',
    [DomainRequestStatus.PURCHASED]: 'green',
    [DomainRequestStatus.DENIED]: 'gray',
    [DomainRequestStatus.FAILED]: 'red',
};

const price = (r: DomainSearchResult) => (r.registrationCost ? `${r.registrationCost} ${r.currency ?? ''}${r.renewalCost ? ` (renews ${r.renewalCost})` : ''}` : '—');

const TeamDomains = ({ ownerId }: { ownerId: string }) => {
    const meCtx = useMe();
    const navigate = useNavigate();

    const team = meCtx.teams.find((t) => t.ownerId === ownerId);
    const canManage = meCtx.isAdmin || !!team?.isOwner;
    const canRequest = canManage || !!team?.capabilities.includes(Capability.CREATE_PROJECT);

    const registrar = useTeamRegistrar(ownerId).data ?? null;
    const configured = !!registrar?.account;
    const spec = registrar?.account ? REGISTRAR_PROVIDER_SPECS[registrar.account.provider] : null;
    const providerLabel = spec?.label ?? 'registrar';
    // In-NSM domain search/purchase is provider-specific (only Cloudflare supports it today).
    const canPurchase = !!spec?.capabilities.purchase;

    const domainsQuery = useTeamDomains(ownerId, configured);
    const requestsQuery = useTeamDomainRequests(ownerId, configured);
    const billingQuery = useTeamDomainBilling(ownerId, configured && canManage);
    const domains = domainsQuery.data ?? [];
    const requests = requestsQuery.data ?? [];
    const billing = billingQuery.data ?? null;

    const searchMutation = useTeamDomainSearch(ownerId);
    const buyMutation = useBuyTeamDomain(ownerId);
    const requestMutation = useRequestTeamDomain(ownerId);
    const decideMutation = useDecideTeamDomainRequest(ownerId);
    const cloudflareSync = useTeamCloudflareSync(ownerId);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<DomainSearchResult[] | null>(null);
    const [pending, setPending] = useState<DomainSearchResult | null>(null);

    const submitting = buyMutation.isPending || requestMutation.isPending || decideMutation.isPending;
    const loading = domainsQuery.isFetching || requestsQuery.isFetching;

    if (!configured) {
        return (
            <Card withBorder>
                <Stack>
                    <Title order={5}>Domains</Title>
                    <Alert color="yellow" variant="light">
                        Configure a registrar above to search for, buy and manage this team&apos;s domains.
                    </Alert>
                </Stack>
            </Card>
        );
    }

    const refresh = () => {
        void domainsQuery.refetch();
        void requestsQuery.refetch();
        if (canManage) void billingQuery.refetch();
    };

    const runSearch = async () => {
        if (!query.trim()) return;
        setResults(null);
        try {
            setResults((await searchMutation.mutateAsync(query.trim())) ?? []);
        } catch {
            notifications.show({ color: 'red', message: 'Search failed. The registrar may not be configured correctly.' });
        }
    };

    const submit = async () => {
        if (!pending) return;
        const body = { domainName: pending.name, priceCurrency: pending.currency, priceRegistration: pending.registrationCost, priceRenewal: pending.renewalCost };
        try {
            if (canManage) {
                notifications.show({ color: 'blue', message: `Purchasing ${pending.name}...` });
                await buyMutation.mutateAsync(body);
                notifications.show({ color: 'green', message: `Purchased ${pending.name}.` });
            } else {
                await requestMutation.mutateAsync(body);
                notifications.show({ color: 'green', message: `Requested ${pending.name}. The team owners have been notified.` });
            }
            setPending(null);
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Request failed.' });
        }
    };

    const runCloudflareSync = async () => {
        try {
            const res = await cloudflareSync.mutateAsync();
            if (res.ok) notifications.show({ color: 'green', title: 'Synced', message: `Synced ${res.zoneCount ?? 0} domain(s) from ${providerLabel}.` });
            else notifications.show({ color: 'red', title: 'Sync failed', message: res.error || 'Sync failed.', autoClose: false });
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Sync failed.' });
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
            await decideMutation.mutateAsync({ requestId: req.id, approve, reason });
        } catch (e) {
            notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Decision failed.' });
        }
    };

    return (
        <Stack>
            <Group justify="space-between" align="center">
                <Title order={5}>Domains</Title>
                <Group gap="xs" align="center">
                    {canManage && (
                        <Tooltip label={`Re-sync domains and DNS records from ${providerLabel} now`}>
                            <Button variant="light" leftSection={<MdOutlineCloudSync />} onClick={runCloudflareSync} loading={cloudflareSync.isPending}>
                                Sync {providerLabel}
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

            {/* Find a domain */}
            {canPurchase && (
            <Card withBorder>
                <Stack>
                    <Title order={6}>Find a domain</Title>
                    {!canRequest && (
                        <Alert color="yellow" variant="light">
                            You need the Create Project capability on this team to request a domain.
                        </Alert>
                    )}
                    <Group>
                        <TextInput flex={1} placeholder="mycoolproject.com" value={query} onChange={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} leftSection={<MdOutlineSearch />} />
                        <Button onClick={runSearch} loading={searchMutation.isPending} disabled={!query.trim()}>
                            Search
                        </Button>
                    </Group>
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
                                            {r.registrable && r.tier !== 'premium' && canRequest && (
                                                <Button size="compact-sm" variant="light" onClick={() => setPending(r)}>
                                                    {canManage ? 'Buy' : 'Request'}
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
            )}

            {/* Requests queue */}
            {canPurchase && requests.length > 0 && (
                <Card withBorder>
                    <Stack>
                        <Title order={6}>Purchase requests</Title>
                        <Table verticalSpacing="xs" fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Domain</Table.Th>
                                    <Table.Th>Requester</Table.Th>
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
                                            {canManage && req.status === DomainRequestStatus.PENDING && (
                                                <Group gap={4} justify="flex-end">
                                                    <Button size="compact-sm" color="green" onClick={() => decide(req, true)} disabled={submitting}>
                                                        Approve &amp; Buy
                                                    </Button>
                                                    <Button size="compact-sm" variant="light" color="red" onClick={() => decide(req, false)} disabled={submitting}>
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

            {/* Owned domains */}
            <Card withBorder>
                <Stack>
                    <Title order={6}>Owned domains</Title>
                    <Text fz="xs" c="dimmed">
                        Click a domain to manage DNS records and billing.
                    </Text>
                    <Table verticalSpacing="xs" highlightOnHover fz="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Domain</Table.Th>
                                <Table.Th>Status</Table.Th>
                                <Table.Th>Records</Table.Th>
                                <Table.Th>Expiry</Table.Th>
                                <Table.Th>Renewal</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {domains.map((z) => (
                                <Table.Tr key={z.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/teams/${ownerId}/domains/${z.id}`)}>
                                    <Table.Td fw={600}>{z.name}</Table.Td>
                                    <Table.Td>
                                        <Badge color={z.status === 'active' ? 'green' : 'yellow'} variant="light">
                                            {z.status}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>{z.recordCount ?? 0}</Table.Td>
                                    <Table.Td>{z.billing?.expiresAt ? new Date(z.billing.expiresAt).toLocaleDateString() : '—'}</Table.Td>
                                    <Table.Td>{z.billing?.renewalCost ? `${z.billing.renewalCost} ${z.billing.currency ?? ''}` : '—'}</Table.Td>
                                </Table.Tr>
                            ))}
                            {domains.length === 0 && (
                                <Table.Tr>
                                    <Table.Td colSpan={5}>
                                        <Text c="dimmed" fz="sm">
                                            No domains yet. Domains will appear here after the next sync.
                                        </Text>
                                    </Table.Td>
                                </Table.Tr>
                            )}
                        </Table.Tbody>
                    </Table>
                </Stack>
            </Card>

            {/* Billing summary */}
            {canManage && billing && billing.totalsByCurrency.length > 0 && (
                <Card withBorder>
                    <Stack gap="xs">
                        <Title order={6}>Billing estimate</Title>
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

            {/* Buy / request modal */}
            <Modal opened={!!pending} onClose={() => setPending(null)} title={<Title order={4}>{canManage ? 'Buy domain' : 'Request domain'}</Title>}>
                {pending && (
                    <Stack>
                        <Text>
                            {pending.name} — {price(pending)}
                        </Text>
                        {canManage && (
                            <Alert color="red" variant="light">
                                Buying registers the domain immediately and is non-refundable.
                            </Alert>
                        )}
                        <Group justify="flex-end">
                            <Button variant="subtle" onClick={() => setPending(null)} disabled={submitting}>
                                Cancel
                            </Button>
                            <Button onClick={submit} loading={submitting} color={canManage ? 'red' : undefined}>
                                {canManage ? 'Buy now' : 'Submit request'}
                            </Button>
                        </Group>
                    </Stack>
                )}
            </Modal>
        </Stack>
    );
};

export default TeamDomains;
