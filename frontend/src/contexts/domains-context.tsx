import { useAPI } from '@/utils/api';
import { useMe } from '@/contexts/me-context';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { DnsZone } from '@mosaiq/nsm-common/types';
import React, { createContext, useContext, useEffect, useState } from 'react';

type DomainsContextType = {
    domains: DnsZone[];
    ready: boolean;
    refresh: () => Promise<void>;
};

const DomainsContext = createContext<DomainsContextType | undefined>(undefined);

// Shared, admin-scoped list of Cloudflare zones. Used by the sidebar dropdown, the domains overview
// page, and the per-domain detail page so they stay in sync after buys/deletes/allocation changes.
const DomainsProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const api = useAPI();
    const meCtx = useMe();
    const [domains, setDomains] = useState<DnsZone[]>([]);
    const [ready, setReady] = useState(false);

    const refresh = async () => {
        if (!api.token || !meCtx.isAdmin) {
            setDomains([]);
            return;
        }
        const res = await api.get(API_ROUTES.GET_DOMAINS, {});
        setDomains(res ?? []);
    };

    useEffect(() => {
        setReady(false);
        refresh().finally(() => setReady(true));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api.token, meCtx.isAdmin]);

    return <DomainsContext.Provider value={{ domains, ready, refresh }}>{children}</DomainsContext.Provider>;
};

const useDomains = () => {
    const context = useContext(DomainsContext);
    if (context === undefined) {
        throw new Error('useDomains must be used within a DomainsProvider');
    }
    return context;
};

export { DomainsProvider, useDomains };
