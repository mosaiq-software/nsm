import { ProjectEvent, ProjectWebhook, ProjectWebhookType } from '@mosaiq/nsm-common/types';
import { buildDiscordRequest, validateDiscordUrl } from './discord';

// A fully-rendered outbound HTTP request that delivers one event to one webhook.
export interface WebhookRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

// The per-type contract that adapts NSM's provider-agnostic ProjectEvent to a concrete receiver.
// Adding a new webhook type is a single entry here plus its formatter module.
export interface WebhookTransport {
    // Turn a normalized event into the receiver-specific HTTP request.
    buildRequest: (event: ProjectEvent, webhook: ProjectWebhook) => WebhookRequest;
    // Validate (and normalize) a user-supplied target URL for this type. Throws on invalid input.
    validateUrl: (url: string) => string;
}

export const webhookTransports: Record<ProjectWebhookType, WebhookTransport> = {
    [ProjectWebhookType.DISCORD]: { buildRequest: buildDiscordRequest, validateUrl: validateDiscordUrl },
};
