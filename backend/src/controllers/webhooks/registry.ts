import { ProjectEvent, ProjectWebhook, ProjectWebhookType } from '@mosaiq/nsm-common/types';
import { buildDiscordNotificationBody, buildDiscordRequest, discordMessageUrl, discordSendWithIdUrl, parseDiscordMessageId, validateDiscordUrl } from './discord';

// A fully-rendered outbound HTTP request that delivers one event to one webhook.
export interface WebhookRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

// Semantic message color for a scenario notification, mapped by each transport to its own palette.
export type NotificationColor = 'open' | 'success' | 'danger' | 'warning' | 'neutral';

// A provider-agnostic scenario notification (GitHub-to-Discord). Transports render this into a
// concrete message body; the same body is reused for create/edit so an edited message keeps shape.
export interface NotificationMessage {
    title: string;
    description?: string;
    url?: string;
    color: NotificationColor;
    fields?: { name: string; value: string }[];
    timestamp: number;
}

// The per-type contract that adapts NSM's provider-agnostic events to a concrete receiver. Adding a
// new webhook type is a single entry here plus its formatter module.
export interface WebhookTransport {
    // Turn a normalized event into the receiver-specific HTTP request.
    buildRequest: (event: ProjectEvent, webhook: ProjectWebhook) => WebhookRequest;
    // Validate (and normalize) a user-supplied target URL for this type. Throws on invalid input.
    validateUrl: (url: string) => string;
    // Whether this transport supports editing/deleting previously-sent messages (message lifecycles).
    supportsMessageEditing: boolean;
    // Render a scenario notification into the request body (POST/PATCH share the same body shape).
    renderNotification: (message: NotificationMessage) => string;
    // The endpoint used to create a message and receive its id back (e.g. Discord's ?wait=true).
    sendWithIdUrl: (webhookUrl: string) => string;
    // The per-message endpoint for edit (PATCH) / delete (DELETE).
    messageUrl: (webhookUrl: string, messageId: string) => string;
    // Parse the created message id from the send response body.
    parseMessageId: (responseJson: any) => string | undefined;
}

export const webhookTransports: Record<ProjectWebhookType, WebhookTransport> = {
    [ProjectWebhookType.DISCORD]: {
        buildRequest: buildDiscordRequest,
        validateUrl: validateDiscordUrl,
        supportsMessageEditing: true,
        renderNotification: buildDiscordNotificationBody,
        sendWithIdUrl: discordSendWithIdUrl,
        messageUrl: discordMessageUrl,
        parseMessageId: parseDiscordMessageId,
    },
};
