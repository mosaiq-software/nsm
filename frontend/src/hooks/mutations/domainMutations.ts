import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DnsRecord } from '@mosaiq/nsm-common/types';

// Search Cloudflare for registrable domains. Pure action; nothing to invalidate.
export const useDomainSearch = () => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (query: string) => (await api.post(API_ROUTES.POST_DOMAIN_SEARCH, {}, { query })) ?? [],
    });
};

type CreateDomainRequestInput = {
    domainName: string;
    ownerId: string;
    priceCurrency?: string;
    priceRegistration?: string;
    priceRenewal?: string;
};

export const useCreateDomainRequest = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: CreateDomainRequestInput) => {
            const created = await api.post(API_ROUTES.POST_DOMAIN_REQUEST, {}, body);
            if (!created) throw new Error('Request failed');
            return created;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.domainRequests() }),
    });
};

export const useDecideDomainRequest = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ requestId, approve, reason }: { requestId: string; approve: boolean; reason?: string }) => api.post(API_ROUTES.POST_DOMAIN_REQUEST_DECIDE, { requestId }, { approve, reason }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.domainRequests() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.domains() });
        },
    });
};

export const useCloudflareSync = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await api.post(API_ROUTES.POST_CLOUDFLARE_SYNC, {}, {});
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.domains() }),
    });
};

export const usePublicIpRefresh = () => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const res = await api.post(API_ROUTES.POST_PUBLIC_IP_REFRESH, {}, {});
            if (!res) throw new Error('Request failed');
            return res;
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.publicIp() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.domains() });
        },
    });
};

// ---- Per-domain (DNS record / allocation / delete) ----

export const useSetDomainAllocations = (zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (ownerIds: string[]) => api.post(API_ROUTES.POST_DOMAIN_ALLOCATIONS, { zoneId }, { ownerIds }),
    });
};

type RecordBody = Partial<DnsRecord>;

export const useCreateDnsRecord = (zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (body: RecordBody) => {
            const res = await api.post(API_ROUTES.POST_DNS_RECORD_CREATE, { zoneId }, body);
            if (res === undefined) throw new Error('Create failed');
            return res;
        },
    });
};

export const useUpdateDnsRecord = (zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async ({ recordId, body }: { recordId: string; body: RecordBody }) => {
            const res = await api.post(API_ROUTES.POST_DNS_RECORD_UPDATE, { zoneId, recordId }, body);
            if (res === undefined) throw new Error('Update failed');
            return res;
        },
    });
};

export const useDeleteDnsRecord = (zoneId: string) => {
    const api = useAPI();
    return useMutation({
        mutationFn: async (recordId: string) => api.post(API_ROUTES.POST_DNS_RECORD_DELETE, { zoneId, recordId }, {}),
    });
};

export const useDeleteDomain = (zoneId: string) => {
    const api = useAPI();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (confirmName: string) => api.post(API_ROUTES.POST_DOMAIN_DELETE, { zoneId }, { confirmName }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.domains() }),
    });
};
