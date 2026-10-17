import { RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { RegistrarProvider } from '@mosaiq/nsm-common/types';
import { CfCreds } from '@/utils/cloudflare';

// Thin provider seam. Cloudflare is the only registrar implemented today; its API client lives in
// `@/utils/cloudflare` and is driven by the CfCreds returned here. Additional providers plug in by
// extending RegistrarProvider, adding a creds-mapping branch below, and (where their API differs)
// their own client module. Keeping the choke point here means callers resolve an account to its
// provider-specific credentials in one place.

export const assertSupportedProvider = (account: RegistrarAccountRecord): void => {
    if (account.provider !== RegistrarProvider.CLOUDFLARE) {
        throw new Error(`Unsupported registrar provider: ${account.provider}`);
    }
};

// Map a stored registrar account's credentials to the Cloudflare client's CfCreds shape. Throws for
// non-Cloudflare providers (none exist yet).
export const cloudflareCredsForAccount = (account: RegistrarAccountRecord): CfCreds => {
    assertSupportedProvider(account);
    return { apiToken: account.credentials.apiToken ?? '', accountId: account.credentials.accountId ?? '' };
};

// Deterministic shared id for an account so multiple teams entering the same provider account
// resolve to a single stored account (and shared domains).
export const registrarAccountId = (provider: RegistrarProvider, values: Record<string, string>): string => {
    if (provider === RegistrarProvider.CLOUDFLARE) return `cloudflare:${(values.accountId || '').trim()}`;
    throw new Error(`Unsupported registrar provider: ${provider}`);
};
