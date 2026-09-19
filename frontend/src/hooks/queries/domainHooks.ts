import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';

export const useDomainRequests = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.domainRequests(),
        queryFn: async () => (await api.get(API_ROUTES.GET_DOMAIN_REQUESTS, {})) ?? [],
        enabled: !!api.token && enabled,
    });
};

export const useDomainBilling = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.domainBilling(),
        queryFn: async () => (await api.get(API_ROUTES.GET_DOMAIN_BILLING, {})) ?? null,
        enabled: !!api.token && enabled,
    });
};

export const usePublicIp = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.publicIp(),
        queryFn: async () => ((await api.get(API_ROUTES.GET_PUBLIC_IP, {})) as { ip: string | null } | undefined)?.ip ?? null,
        enabled: !!api.token && enabled,
    });
};

export const useDnsRecords = (zoneId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.dnsRecords(zoneId),
        queryFn: async () => (await api.get(API_ROUTES.GET_DNS_RECORDS, { zoneId })) ?? [],
        enabled: !!api.token && !!zoneId && enabled,
    });
};

export const useDnsAnalytics = (zoneId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.dnsAnalytics(zoneId),
        queryFn: async () => (await api.get(API_ROUTES.GET_DNS_ANALYTICS, { zoneId })) ?? null,
        enabled: !!api.token && !!zoneId && enabled,
    });
};

export const usePortReservations = (enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.portReservations(),
        queryFn: async () => (await api.get(API_ROUTES.GET_PORT_RESERVATIONS, {})) ?? [],
        enabled: !!api.token && enabled,
    });
};
