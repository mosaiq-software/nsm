import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';

// Team registrar config (secret-free). Only team owners/admins can read it.
export const useTeamRegistrar = (ownerId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamRegistrar(ownerId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_REGISTRAR, { ownerId })) ?? null,
        enabled: !!api.token && !!ownerId && enabled,
    });
};

// Domains belonging to the team's registrar account.
export const useTeamDomains = (ownerId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamDomains(ownerId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_DOMAINS, { ownerId })) ?? [],
        enabled: !!api.token && !!ownerId && enabled,
    });
};

export const useTeamDomainRequests = (ownerId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamDomainRequests(ownerId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_DOMAIN_REQUESTS, { ownerId })) ?? [],
        enabled: !!api.token && !!ownerId && enabled,
    });
};

export const useTeamDomainBilling = (ownerId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamDomainBilling(ownerId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_DOMAIN_BILLING, { ownerId })) ?? null,
        enabled: !!api.token && !!ownerId && enabled,
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

export const useTeamDnsRecords = (ownerId: string, zoneId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamDnsRecords(ownerId, zoneId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_DNS_RECORDS, { ownerId, zoneId })) ?? [],
        enabled: !!api.token && !!ownerId && !!zoneId && enabled,
    });
};

export const useTeamDnsAnalytics = (ownerId: string, zoneId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamDnsAnalytics(ownerId, zoneId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_DNS_ANALYTICS, { ownerId, zoneId })) ?? null,
        enabled: !!api.token && !!ownerId && !!zoneId && enabled,
    });
};

// Port reservations for the team's own projects, scoped server-side. Drives the DNS record
// port-binding picker so team owners (not just NSM admins) see their reservations.
export const useTeamPortReservations = (ownerId: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.teamPortReservations(ownerId),
        queryFn: async () => (await api.get(API_ROUTES.GET_TEAM_PORT_RESERVATIONS, { ownerId })) ?? [],
        enabled: !!api.token && !!ownerId && enabled,
    });
};
