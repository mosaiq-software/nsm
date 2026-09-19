import crypto from 'crypto';
import { ApiKey, ApiKeyPermission, ApiKeyView, CreateApiKeyBody, CreateApiKeyResult } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { deleteApiKeysForProjectModel, getApiKeyByHashModel, getApiKeyByIdModel, getApiKeysByProjectModel, touchApiKeyModel } from '@/persistence/apiKeyPersistence';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const apiKeyLog = areaLog('apikeys');

const ALL_PERMISSIONS = new Set<ApiKeyPermission>(Object.values(ApiKeyPermission));

const hashKey = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

const toView = (key: ApiKey): ApiKeyView => {
    const { hashedKey: _omit, ...view } = key;
    return view;
};

export const listApiKeys = async (projectId: string): Promise<ApiKeyView[]> => {
    return (await getApiKeysByProjectModel(projectId)).map(toView);
};

export const createApiKey = async (projectId: string, body: CreateApiKeyBody, actor: string): Promise<CreateApiKeyResult> => {
    const name = body.name?.trim();
    if (!name) throw new Error('A name is required');
    const permissions = (body.permissions || []).filter((p) => ALL_PERMISSIONS.has(p));
    if (!permissions.length) throw new Error('At least one permission is required');

    // Key format: nsm_<prefix>_<secret>. The prefix is stored for display; only the SHA-256 hash of
    // the whole key is persisted.
    const prefix = crypto.randomBytes(4).toString('hex');
    const secretPart = crypto.randomBytes(24).toString('hex');
    const rawKey = `nsm_${prefix}_${secretPart}`;

    const apiKey: ApiKey = {
        id: crypto.randomUUID(),
        projectId,
        name,
        prefix,
        hashedKey: hashKey(rawKey),
        permissions,
        createdBy: actor,
        createdAt: Date.now(),
    };
    await cluster.propose({ type: OpType.UPSERT_API_KEY, apiKey });
    apiKeyLog.info({ action: 'api_key_created', projectId, apiKeyId: apiKey.id, permissions }, `API key created for ${projectId}`);
    return { key: toView(apiKey), secret: rawKey };
};

export const revokeApiKey = async (projectId: string, apiKeyId: string): Promise<void> => {
    const existing = await getApiKeyByIdModel(apiKeyId);
    if (!existing || existing.projectId !== projectId) return;
    if (existing.revokedAt) return;
    await cluster.propose({ type: OpType.REVOKE_API_KEY, apiKeyId, revokedAt: Date.now() });
    apiKeyLog.info({ action: 'api_key_revoked', projectId, apiKeyId }, `API key ${apiKeyId} revoked`);
};

// Authenticate a raw API key: returns the project it is scoped to and its granted permissions, or
// null when the key is unknown or revoked. Updates lastUsedAt as a side effect (best-effort).
export const authenticateApiKey = async (rawKey: string): Promise<{ projectId: string; permissions: ApiKeyPermission[] } | null> => {
    if (!rawKey || !rawKey.startsWith('nsm_')) return null;
    const key = await getApiKeyByHashModel(hashKey(rawKey));
    if (!key || key.revokedAt) return null;
    void touchApiKeyModel(key.id, Date.now()).catch(() => {});
    return { projectId: key.projectId, permissions: key.permissions };
};

export const clearProjectApiKeys = async (projectId: string): Promise<void> => {
    await deleteApiKeysForProjectModel(projectId);
};
