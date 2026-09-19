import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { useMe } from '@/hooks/queries/useMe';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DnsZone } from '@mosaiq/nsm-common/types';

type UseDomainsResult = {
    domains: DnsZone[];
    ready: boolean;
    refresh: () => Promise<void>;
};

// Shared, admin-scoped list of Cloudflare zones. Used by the sidebar dropdown, the domains overview
// page, and the per-domain detail page so they stay in sync after buys/deletes/allocation changes.
// Replaces DomainsProvider.
export const useDomains = (): UseDomainsResult => {
    const api = useAPI();
    const { isAdmin } = useMe();
    const queryClient = useQueryClient();

    const enabled = !!api.token && isAdmin;
    const query = useQuery({
        queryKey: queryKeys.domains(),
        queryFn: async () => (await api.get(API_ROUTES.GET_DOMAINS, {})) ?? [],
        enabled,
    });

    const refresh = async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.domains() });
    };

    return {
        domains: enabled ? (query.data ?? []) : [],
        ready: enabled ? query.isSuccess || query.isError : true,
        refresh,
    };
};
