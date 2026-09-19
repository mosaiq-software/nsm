import crypto from 'crypto';
import { ALL_GITHUB_SCENARIOS, ALL_PROJECT_EVENT_TYPES, CreateProjectWebhookBody, GITHUB_SCENARIO_SUBEVENTS, GithubScenario, GithubScenarioConfig, GithubScenarioLifecycle, ProjectEvent, ProjectEventSeverity, ProjectEventType, ProjectWebhook, ProjectWebhookType, UpdateProjectWebhookBody } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { deleteWebhooksForProjectModel, getProjectWebhookByIdModel, getWebhooksByProjectModel } from '@/persistence/projectWebhookPersistence';
import { deleteDiscordMessageRefsForProjectModel, deleteDiscordMessageRefsForWebhookModel } from '@/persistence/discordMessageRefPersistence';
import { NotificationMessage, webhookTransports } from '@/controllers/webhooks/registry';
import { projectEventUrl } from '@/controllers/webhooks/events';
import { ensureGithubWebhook, removeGithubWebhookIfUnused } from '@/controllers/githubWebhookProvisioning';
import { isGithubAppConfigured } from '@/config';
import { cluster } from '@/cluster/node';
import { areaLog, serializeError } from '@/utils/log';

const webhookLog = areaLog('webhooks');

const VALID_EVENTS = new Set<ProjectEventType>(ALL_PROJECT_EVENT_TYPES);
const VALID_TYPES = new Set<ProjectWebhookType>(Object.values(ProjectWebhookType));

// Per-attempt delivery timeout and the max time to honor a 429 backoff before giving up.
const DELIVERY_TIMEOUT_MS = 8000;
const MAX_RETRY_DELAY_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Redact the secret token in a webhook URL, keeping enough to identify it (scheme/host/path prefix).
// For Discord (/api/webhooks/{id}/{token}) this keeps the id and masks the token.
const maskWebhookUrl = (url: string): string => {
    const idx = url.lastIndexOf('/');
    if (idx <= 'https://'.length) return '••••••••';
    return `${url.slice(0, idx + 1)}${'•'.repeat(10)}`;
};

// Projection sent to clients: the stored URL is a delivery secret, so it is always masked.
const toMaskedView = (webhook: ProjectWebhook): ProjectWebhook => ({ ...webhook, url: maskWebhookUrl(webhook.url) });

const normalizeEvents = (events: ProjectEventType[] | undefined): ProjectEventType[] => {
    const unique = new Set((events || []).filter((e) => VALID_EVENTS.has(e)));
    return [...unique];
};

const VALID_SCENARIOS = new Set<GithubScenario>(ALL_GITHUB_SCENARIOS);
const VALID_LIFECYCLES = new Set<GithubScenarioLifecycle>(['new', 'update', 'update_then_delete']);

// Sanitize user-supplied GitHub scenario config: drop unknown scenarios/sub-events, de-duplicate by
// scenario, require at least one valid sub-event, and default an invalid lifecycle to 'new'.
const normalizeGithubScenarios = (scenarios: GithubScenarioConfig[] | undefined): GithubScenarioConfig[] => {
    if (!scenarios) return [];
    const byScenario = new Map<GithubScenario, GithubScenarioConfig>();
    for (const s of scenarios) {
        if (!VALID_SCENARIOS.has(s.scenario)) continue;
        const allowed = new Set(GITHUB_SCENARIO_SUBEVENTS[s.scenario]);
        const on = [...new Set((s.on || []).filter((e) => allowed.has(e)))];
        if (!on.length) continue;
        const lifecycle = VALID_LIFECYCLES.has(s.lifecycle) ? s.lifecycle : 'new';
        const branches = s.branches?.map((b) => b.trim()).filter(Boolean);
        byScenario.set(s.scenario, { scenario: s.scenario, on, lifecycle, branches: branches && branches.length ? branches : undefined });
    }
    return [...byScenario.values()];
};

export const listWebhooks = async (projectId: string): Promise<ProjectWebhook[]> => {
    return (await getWebhooksByProjectModel(projectId)).map(toMaskedView);
};

export const createWebhook = async (projectId: string, body: CreateProjectWebhookBody, actor: string): Promise<ProjectWebhook> => {
    const name = body.name?.trim();
    if (!name) throw new Error('A name is required');
    if (!VALID_TYPES.has(body.type)) throw new Error('Unsupported webhook type');
    const events = normalizeEvents(body.events);
    const githubScenarios = normalizeGithubScenarios(body.githubScenarios);
    if (!events.length && !githubScenarios.length) throw new Error('Select at least one event or GitHub scenario');
    // Validates + normalizes the target URL for the chosen type (throws on invalid/unsafe URLs).
    const url = webhookTransports[body.type].validateUrl(body.url || '');

    const now = Date.now();
    const webhook: ProjectWebhook = {
        id: crypto.randomUUID(),
        projectId,
        type: body.type,
        name,
        url,
        events,
        githubScenarios,
        enabled: body.enabled ?? true,
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_PROJECT_WEBHOOK, webhook });
    // Any GitHub scenario subscription needs the shared GitHub webhook to be provisioned.
    if (githubScenarios.length && isGithubAppConfigured()) {
        await ensureGithubWebhook(projectId).catch((e: any) => webhookLog.warn({ action: 'webhook_ensure_github_failed', projectId, err: serializeError(e) }, `failed to ensure GitHub webhook for ${projectId}`));
    }
    webhookLog.info({ action: 'webhook_created', projectId, webhookId: webhook.id, type: webhook.type, eventCount: events.length, scenarioCount: githubScenarios.length }, `webhook created for ${projectId}`);
    return toMaskedView(webhook);
};

export const updateWebhook = async (projectId: string, webhookId: string, body: UpdateProjectWebhookBody, actor: string): Promise<ProjectWebhook> => {
    const existing = await getProjectWebhookByIdModel(webhookId);
    if (!existing || existing.projectId !== projectId) throw new Error('Webhook not found');

    // A URL that is omitted, blank, or the masked placeholder means "keep the stored secret".
    let url = existing.url;
    if (body.url !== undefined && body.url.trim() && body.url !== maskWebhookUrl(existing.url)) {
        url = webhookTransports[existing.type].validateUrl(body.url);
    }
    const events = body.events !== undefined ? normalizeEvents(body.events) : existing.events;
    const githubScenarios = body.githubScenarios !== undefined ? normalizeGithubScenarios(body.githubScenarios) : existing.githubScenarios || [];
    if (!events.length && !githubScenarios.length) throw new Error('Select at least one event or GitHub scenario');
    const name = body.name !== undefined ? body.name.trim() : existing.name;
    if (!name) throw new Error('A name is required');

    const updated: ProjectWebhook = {
        ...existing,
        name,
        url,
        events,
        githubScenarios,
        enabled: body.enabled ?? existing.enabled,
        updatedAt: Date.now(),
    };
    await cluster.propose({ type: OpType.UPSERT_PROJECT_WEBHOOK, webhook: updated });
    void actor;
    // Reconcile the shared GitHub webhook: provision it if scenarios are now configured, or remove it
    // if this edit dropped the last consumer.
    if (isGithubAppConfigured()) {
        if (githubScenarios.length) await ensureGithubWebhook(projectId).catch((e: any) => webhookLog.warn({ action: 'webhook_ensure_github_failed', projectId, err: serializeError(e) }, `failed to ensure GitHub webhook for ${projectId}`));
        else await removeGithubWebhookIfUnused(projectId).catch((e: any) => webhookLog.warn({ action: 'webhook_remove_github_failed', projectId, err: serializeError(e) }, `failed to remove GitHub webhook for ${projectId}`));
    }
    webhookLog.info({ action: 'webhook_updated', projectId, webhookId, eventCount: events.length, scenarioCount: githubScenarios.length, enabled: updated.enabled }, `webhook ${webhookId} updated`);
    return toMaskedView(updated);
};

export const deleteWebhook = async (projectId: string, webhookId: string): Promise<void> => {
    const existing = await getProjectWebhookByIdModel(webhookId);
    if (!existing || existing.projectId !== projectId) return;
    await cluster.propose({ type: OpType.DELETE_PROJECT_WEBHOOK, webhookId });
    // Best-effort cleanup of tracked Discord message refs for this webhook (leader-local).
    await deleteDiscordMessageRefsForWebhookModel(webhookId).catch(() => {});
    if (isGithubAppConfigured()) await removeGithubWebhookIfUnused(projectId).catch((e: any) => webhookLog.warn({ action: 'webhook_remove_github_failed', projectId, err: serializeError(e) }, `failed to remove GitHub webhook for ${projectId}`));
    webhookLog.info({ action: 'webhook_deleted', projectId, webhookId }, `webhook ${webhookId} deleted`);
};

export const clearProjectWebhooks = async (projectId: string): Promise<void> => {
    await deleteWebhooksForProjectModel(projectId);
    await deleteDiscordMessageRefsForProjectModel(projectId);
};

// Deliver one rendered request, returning the HTTP status and any 429 backoff (ms). Never throws for
// HTTP errors; transport failures (timeout/DNS) reject and are handled by the caller.
const deliverOnce = async (url: string, headers: Record<string, string>, bodyText: string): Promise<{ status: number; retryAfterMs?: number }> => {
    const res = await fetch(url, { method: 'POST', headers, body: bodyText, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
    let retryAfterMs: number | undefined;
    if (res.status === 429) {
        const header = res.headers.get('retry-after');
        if (header) retryAfterMs = parseFloat(header) * 1000;
        try {
            const json = (await res.json()) as { retry_after?: number };
            if (typeof json?.retry_after === 'number') retryAfterMs = json.retry_after * 1000;
        } catch {
            // Non-JSON body; fall back to the header (or default) delay.
        }
    }
    return { status: res.status, retryAfterMs };
};

// Deliver an event to a single webhook with one retry on 429/5xx. Returns whether it was accepted.
const deliverToWebhook = async (webhook: ProjectWebhook, event: ProjectEvent): Promise<boolean> => {
    const transport = webhookTransports[webhook.type];
    if (!transport) return false;
    const req = transport.buildRequest(event, webhook);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { status, retryAfterMs } = await deliverOnce(req.url, req.headers, req.body);
            if (status >= 200 && status < 300) return true;
            const retryable = status === 429 || status >= 500;
            if (retryable && attempt === 0) {
                await sleep(Math.min(retryAfterMs ?? 1000, MAX_RETRY_DELAY_MS));
                continue;
            }
            webhookLog.warn({ action: 'webhook_delivery_failed', webhookId: webhook.id, projectId: webhook.projectId, type: webhook.type, status }, `webhook ${webhook.id} delivery failed (HTTP ${status})`);
            return false;
        } catch (e: any) {
            if (attempt === 0) {
                await sleep(1000);
                continue;
            }
            webhookLog.warn({ action: 'webhook_delivery_error', webhookId: webhook.id, projectId: webhook.projectId, type: webhook.type, err: serializeError(e) }, `webhook ${webhook.id} delivery errored`);
            return false;
        }
    }
    return false;
};

// Fire a normalized project event to every enabled webhook subscribed to it. Leader-only and
// fire-and-forget: callers `void` this and it never rejects (all failures are swallowed and logged).
export const emitProjectEvent = async (event: ProjectEvent): Promise<void> => {
    try {
        if (!cluster.isLeader()) return;
        const webhooks = await getWebhooksByProjectModel(event.projectId);
        const targets = webhooks.filter((w) => w.enabled && w.events.includes(event.type));
        if (!targets.length) return;
        const results = await Promise.allSettled(targets.map((w) => deliverToWebhook(w, event)));
        const sentCount = results.filter((r) => r.status === 'fulfilled' && r.value).length;
        webhookLog.info({ action: 'webhook_event_dispatched', projectId: event.projectId, event: event.type, targetCount: targets.length, sentCount }, `dispatched ${event.type} to ${sentCount}/${targets.length} webhook(s) for ${event.projectId}`);
    } catch (e: any) {
        webhookLog.error({ action: 'webhook_dispatch_failed', projectId: event.projectId, event: event.type, err: serializeError(e) }, 'failed to dispatch project event');
    }
};

// Perform one notification delivery (create/edit/delete), parsing any JSON body and 429 backoff.
// Never throws for HTTP errors; transport failures (timeout/DNS) reject and are handled by the caller.
const deliverNotificationOnce = async (url: string, method: 'POST' | 'PATCH' | 'DELETE', bodyText?: string): Promise<{ status: number; json?: any; retryAfterMs?: number }> => {
    const headers: Record<string, string> = bodyText ? { 'Content-Type': 'application/json' } : {};
    const res = await fetch(url, { method, headers, body: bodyText, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
    const text = await res.text().catch(() => '');
    let json: any;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            // Non-JSON body (e.g. empty 204); leave json undefined.
        }
    }
    let retryAfterMs: number | undefined;
    if (res.status === 429) {
        const header = res.headers.get('retry-after');
        if (header) retryAfterMs = parseFloat(header) * 1000;
        if (typeof json?.retry_after === 'number') retryAfterMs = json.retry_after * 1000;
    }
    return { status: res.status, json, retryAfterMs };
};

// Run a notification delivery with a single retry on 429/5xx. Returns the successful response's
// parsed body, or null when it ultimately failed.
const deliverNotificationWithRetry = async (webhook: ProjectWebhook, url: string, method: 'POST' | 'PATCH' | 'DELETE', bodyText?: string): Promise<{ json?: any } | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { status, json, retryAfterMs } = await deliverNotificationOnce(url, method, bodyText);
            if (status >= 200 && status < 300) return { json };
            const retryable = status === 429 || status >= 500;
            if (retryable && attempt === 0) {
                await sleep(Math.min(retryAfterMs ?? 1000, MAX_RETRY_DELAY_MS));
                continue;
            }
            webhookLog.warn({ action: 'notification_delivery_failed', webhookId: webhook.id, projectId: webhook.projectId, method, status }, `notification ${method} failed (HTTP ${status})`);
            return null;
        } catch (e: any) {
            if (attempt === 0) {
                await sleep(1000);
                continue;
            }
            webhookLog.warn({ action: 'notification_delivery_error', webhookId: webhook.id, projectId: webhook.projectId, method, err: serializeError(e) }, `notification ${method} errored`);
            return null;
        }
    }
    return null;
};

// Send a scenario notification and capture the created message id (for later edit/delete). Returns
// the message id, or null on failure.
export const sendScenarioMessage = async (webhook: ProjectWebhook, message: NotificationMessage): Promise<string | null> => {
    const transport = webhookTransports[webhook.type];
    if (!transport?.supportsMessageEditing) return null;
    const url = transport.sendWithIdUrl(webhook.url);
    const body = transport.renderNotification(message);
    const result = await deliverNotificationWithRetry(webhook, url, 'POST', body);
    if (!result) return null;
    return transport.parseMessageId(result.json) ?? null;
};

// Edit a previously-sent scenario message in place. Returns whether the edit succeeded.
export const editScenarioMessage = async (webhook: ProjectWebhook, messageId: string, message: NotificationMessage): Promise<boolean> => {
    const transport = webhookTransports[webhook.type];
    if (!transport?.supportsMessageEditing) return false;
    const url = transport.messageUrl(webhook.url, messageId);
    const body = transport.renderNotification(message);
    return (await deliverNotificationWithRetry(webhook, url, 'PATCH', body)) !== null;
};

// Delete a previously-sent scenario message. Returns whether the delete succeeded.
export const deleteScenarioMessage = async (webhook: ProjectWebhook, messageId: string): Promise<boolean> => {
    const transport = webhookTransports[webhook.type];
    if (!transport?.supportsMessageEditing) return false;
    const url = transport.messageUrl(webhook.url, messageId);
    return (await deliverNotificationWithRetry(webhook, url, 'DELETE')) !== null;
};

// Deliver a synthetic event to one webhook so the user can verify their configuration. Unlike
// emitProjectEvent this ignores the enabled flag and subscriptions (it is an explicit manual test).
export const testWebhook = async (projectId: string, webhookId: string): Promise<{ ok: boolean }> => {
    const webhook = await getProjectWebhookByIdModel(webhookId);
    if (!webhook || webhook.projectId !== projectId) throw new Error('Webhook not found');
    const event: ProjectEvent = {
        type: ProjectEventType.DEPLOY_SUCCEEDED,
        projectId,
        severity: ProjectEventSeverity.INFO,
        title: `Test webhook: ${projectId}`,
        description: `This is a test message from NSM for "${webhook.name}". If you can see this, the webhook is configured correctly.`,
        url: projectEventUrl(projectId, '/config'),
        timestamp: Date.now(),
    };
    const ok = await deliverToWebhook(webhook, event);
    webhookLog.info({ action: 'webhook_tested', projectId, webhookId, ok }, `tested webhook ${webhookId}: ${ok ? 'ok' : 'failed'}`);
    return { ok };
};
