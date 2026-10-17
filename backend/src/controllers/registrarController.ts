import { OpType, RegistrarAccountRecord } from '@mosaiq/nsm-common/clusterOps';
import { REGISTRAR_PROVIDER_SPECS, RegistrarAccountSummary, RegistrarProvider, TeamRegistrarConfig, User } from '@mosaiq/nsm-common/types';
import { cluster } from '@/cluster/node';
import { canManageTeam, resolveTeamById } from '@/controllers/authz';
import { getAllRegistrarAccountsModel, getRegistrarAccountModel } from '@/persistence/registrarAccountPersistence';
import { getTeamRegistrarModel, getTeamsForRegistrarAccountModel } from '@/persistence/teamRegistrarPersistence';
import { getAllDnsZonesModel, getDnsZoneModel } from '@/persistence/dnsZonePersistence';
import { CfCreds } from '@/utils/cloudflare';
import { cloudflareCredsForAccount, registrarAccountId } from '@/registrar/provider';
import { areaLog } from '@/utils/log';

const registrarLog = areaLog('cloudflare');

// === Secret-free summary ===

// Build the UI-safe view of an account: non-secret field values inline, secret fields reported only
// by name so the form can show a configured state. Secret values are never serialized.
export const buildAccountSummary = (account: RegistrarAccountRecord): RegistrarAccountSummary => {
    const spec = REGISTRAR_PROVIDER_SPECS[account.provider];
    const nonSecretValues: Record<string, string> = {};
    const configuredSecrets: string[] = [];
    for (const field of spec?.fields ?? []) {
        const value = account.credentials[field.key];
        if (field.secret) {
            if (value) configuredSecrets.push(field.key);
        } else if (value !== undefined) {
            nonSecretValues[field.key] = value;
        }
    }
    return { id: account.id, provider: account.provider, label: account.label, nonSecretValues, configuredSecrets };
};

// === Credential resolution ===

export const getRegistrarAccountForTeam = async (ownerId: string): Promise<RegistrarAccountRecord | null> => {
    const accountId = await getTeamRegistrarModel(ownerId);
    if (!accountId) return null;
    return getRegistrarAccountModel(accountId);
};

export const getCredsForTeam = async (ownerId: string): Promise<CfCreds | null> => {
    const account = await getRegistrarAccountForTeam(ownerId);
    return account ? cloudflareCredsForAccount(account) : null;
};

export const teamHasRegistrar = async (ownerId: string): Promise<boolean> => {
    const creds = await getCredsForTeam(ownerId);
    return !!creds?.apiToken;
};

export const getRegistrarAccountForZone = async (zoneId: string): Promise<RegistrarAccountRecord | null> => {
    const zone = await getDnsZoneModel(zoneId);
    if (!zone?.registrarAccountId) return null;
    return getRegistrarAccountModel(zone.registrarAccountId);
};

export const getCredsForZone = async (zoneId: string): Promise<CfCreds | null> => {
    const account = await getRegistrarAccountForZone(zoneId);
    return account ? cloudflareCredsForAccount(account) : null;
};

// Resolve the registrar account whose zone owns the given FQDN (longest-suffix match: app.foo.com ->
// zone foo.com). Used by cert issuance to pick the Cloudflare account for a DNS-01 challenge.
export const getAccountForDomain = async (domain: string): Promise<RegistrarAccountRecord | null> => {
    const fqdn = domain.toLowerCase().replace(/\.$/, '');
    const zones = await getAllDnsZonesModel();
    const matches = zones
        .filter((z) => z.registrarAccountId && (fqdn === z.name.toLowerCase() || fqdn.endsWith(`.${z.name.toLowerCase()}`)))
        .sort((a, b) => b.name.length - a.name.length);
    const zone = matches[0];
    if (!zone?.registrarAccountId) return null;
    return getRegistrarAccountModel(zone.registrarAccountId);
};

export const getCredsForDomain = async (domain: string): Promise<CfCreds | null> => {
    const account = await getAccountForDomain(domain);
    return account ? cloudflareCredsForAccount(account) : null;
};

// All configured accounts paired with their Cloudflare credentials, for cluster-wide reconcile
// (sync, dynamic-IP). Only accounts with a usable token are returned.
export const getAllAccountCreds = async (): Promise<{ account: RegistrarAccountRecord; creds: CfCreds }[]> => {
    const accounts = await getAllRegistrarAccountsModel();
    const out: { account: RegistrarAccountRecord; creds: CfCreds }[] = [];
    for (const account of accounts) {
        try {
            const creds = cloudflareCredsForAccount(account);
            if (creds.apiToken) out.push({ account, creds });
        } catch {
            // Unsupported provider in the store (shouldn't happen today); skip rather than crash the reconcile.
            registrarLog.warn({ action: 'registrar_account_skipped', accountId: account.id, provider: account.provider }, 'skipping unsupported registrar account');
        }
    }
    return out;
};

export const anyRegistrarConfigured = async (): Promise<boolean> => {
    return (await getAllAccountCreds()).length > 0;
};

// === Team registrar settings (secret-masked) ===

export const getTeamRegistrarConfig = async (user: User, ownerId: string): Promise<TeamRegistrarConfig> => {
    const team = await resolveTeamById(ownerId);
    const canManage = team ? await canManageTeam(user, team) : false;
    const account = await getRegistrarAccountForTeam(ownerId);
    return { account: account ? buildAccountSummary(account) : null, canManage };
};

// Validate + persist a team's registrar account. Blank secret fields on an existing account preserve
// the stored secret (edit-without-retyping). The resulting account is shared by id, so editing it
// affects every team pointing at the same provider account.
export const saveTeamRegistrar = async (ownerId: string, provider: RegistrarProvider, values: Record<string, string>): Promise<TeamRegistrarConfig> => {
    const spec = REGISTRAR_PROVIDER_SPECS[provider];
    if (!spec) throw new Error(`Unsupported registrar provider: ${provider}`);

    const id = registrarAccountId(provider, values);
    const existing = await getRegistrarAccountModel(id);

    const credentials: Record<string, string> = { ...(existing?.credentials ?? {}) };
    for (const field of spec.fields) {
        const submitted = (values[field.key] ?? '').trim();
        if (submitted) {
            credentials[field.key] = submitted;
        } else if (field.required && !(field.secret && credentials[field.key])) {
            // Required field is blank and we have no stored secret to fall back on.
            throw new Error(`Missing required field: ${field.label}`);
        }
        // A blank secret with an existing stored value keeps the stored value (already copied above).
    }

    const account: RegistrarAccountRecord = {
        id,
        provider,
        label: existing?.label ?? spec.label,
        credentials,
        createdAt: existing?.createdAt ?? Date.now(),
    };
    await cluster.propose({ type: OpType.UPSERT_REGISTRAR_ACCOUNT, account });
    await cluster.propose({ type: OpType.SET_TEAM_REGISTRAR, ownerId, registrarAccountId: id });
    registrarLog.info({ action: 'registrar_saved', ownerId, accountId: id, provider }, `saved registrar for team ${ownerId}`);

    return { account: buildAccountSummary(account), canManage: true };
};

// Unlink a team from its registrar account, deleting the account only when no other team references
// it (shared accounts stay for their remaining consumers).
export const removeTeamRegistrar = async (ownerId: string): Promise<TeamRegistrarConfig> => {
    const accountId = await getTeamRegistrarModel(ownerId);
    await cluster.propose({ type: OpType.SET_TEAM_REGISTRAR, ownerId, registrarAccountId: null });
    if (accountId) {
        const others = (await getTeamsForRegistrarAccountModel(accountId)).filter((o) => o !== ownerId);
        if (others.length === 0) {
            await cluster.propose({ type: OpType.DELETE_REGISTRAR_ACCOUNT, accountId });
            registrarLog.info({ action: 'registrar_account_deleted', accountId }, `deleted unreferenced registrar account ${accountId}`);
        }
    }
    registrarLog.info({ action: 'registrar_removed', ownerId }, `removed registrar for team ${ownerId}`);
    return { account: null, canManage: true };
};
