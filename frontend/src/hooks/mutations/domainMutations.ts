import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DnsRecord, RegistrarProvider } from '@mosaiq/nsm-common/types';

// ---- Registrar settings ----

export const useSaveTeamRegistrar = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ provider, values }: { provider: RegistrarProvider; values: Record<string, string> }) => {
            const res = await api.post(API_ROUTES.POST_TEAM_REGISTRAR, { ownerId }, { provider, values });
            if (!res) throw new Error('Save failed');
            return res;
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamRegistrar(ownerId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) });
        },
    });
};

export const useRemoveTeamRegistrar = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => api.post(API_ROUTES.POST_TEAM_REGISTRAR_REMOVE, { ownerId }, {}),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamRegistrar(ownerId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) });
        },
    });
};

// ---- Search / buy / request ----

// Search the team's registrar for registrable domains. Pure action; nothing to invalidate.
export const useTeamDomainSearch = (ownerId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (query: string) => (await api.post(API_ROUTES.POST_TEAM_DOMAIN_SEARCH, { ownerId }, { query })) ?? [],
    });
};

type PriceInput = {
    domainName: string;
    priceCurrency?: string;
    priceRegistration?: string;
    priceRenewal?: string;
};

// Owner self-service purchase (registers immediately on the team's registrar account).
export const useBuyTeamDomain = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: PriceInput) => {
            const created = await api.post(API_ROUTES.POST_TEAM_DOMAIN_BUY, { ownerId }, body);
            if (!created) throw new Error('Purchase failed');
            return created;
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomainRequests(ownerId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) });
        },
    });
};

// Non-owner member submits a request routed to the team owners for approval.
export const useRequestTeamDomain = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: PriceInput) => {
            const created = await api.post(API_ROUTES.POST_TEAM_DOMAIN_REQUEST, { ownerId }, body);
            if (!created) throw new Error('Request failed');
            return created;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teamDomainRequests(ownerId) }),
    });
};

export const useDecideTeamDomainRequest = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ requestId, approve, reason }: { requestId: string; approve: boolean; reason?: string }) =>
            api.post(API_ROUTES.POST_TEAM_DOMAIN_REQUEST_DECIDE, { ownerId, requestId }, { approve, reason }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomainRequests(ownerId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) });
        },
    });
};

export const useTeamCloudflareSync = (ownerId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await api.post(API_ROUTES.POST_TEAM_DOMAIN_SYNC, { ownerId }, {});
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) }),
    });
};

// Cluster-wide dynamic-DNS refresh (not team-scoped). Surfaced on the Nodes page.
export const usePublicIpRefresh = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await api.post(API_ROUTES.POST_PUBLIC_IP_REFRESH, {}, {});
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.publicIp() }),
    });
};

// ---- Per-domain (DNS record / delete) ----

type RecordBody = Partial<DnsRecord>;

export const useCreateDnsRecord = (ownerId: string, zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (body: RecordBody) => {
            const res = await api.post(API_ROUTES.POST_TEAM_DNS_RECORD_CREATE, { ownerId, zoneId }, body);
            if (res === undefined) throw new Error('Create failed');
            return res;
        },
    });
};

export const useUpdateDnsRecord = (ownerId: string, zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async ({ recordId, body }: { recordId: string; body: RecordBody }) => {
            const res = await api.post(API_ROUTES.POST_TEAM_DNS_RECORD_UPDATE, { ownerId, zoneId, recordId }, body);
            if (res === undefined) throw new Error('Update failed');
            return res;
        },
    });
};

export const useDeleteDnsRecord = (ownerId: string, zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (recordId: string) => api.post(API_ROUTES.POST_TEAM_DNS_RECORD_DELETE, { ownerId, zoneId, recordId }, {}),
    });
};

export const useDeleteDomain = (ownerId: string, zoneId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (confirmName: string) => api.post(API_ROUTES.POST_TEAM_DOMAIN_DELETE, { ownerId, zoneId }, { confirmName }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teamDomains(ownerId) }),
    });
};
