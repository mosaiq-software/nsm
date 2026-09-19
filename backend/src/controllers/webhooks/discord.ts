import { ProjectEvent, ProjectEventSeverity, ProjectWebhook } from '@mosaiq/nsm-common/types';
import type { NotificationColor, NotificationMessage, WebhookRequest } from './registry';

// Discord embed accent color per severity (standard Discord palette).
const EMBED_COLORS: Record<ProjectEventSeverity, number> = {
    [ProjectEventSeverity.INFO]: 0x5865f2, // blurple
    [ProjectEventSeverity.SUCCESS]: 0x57f287, // green
    [ProjectEventSeverity.WARNING]: 0xe67e22, // orange
    [ProjectEventSeverity.ERROR]: 0xed4245, // red
};

// Discord embed accent color per semantic notification color (standard Discord palette).
const NOTIFICATION_COLORS: Record<NotificationColor, number> = {
    open: 0x5865f2, // blurple - a subject is open/in-progress
    success: 0x57f287, // green - approved / merged / succeeded
    danger: 0xed4245, // red - failed / changes requested
    warning: 0xe67e22, // orange
    neutral: 0x99aab5, // grey - closed without a positive outcome
};

// Hosts Discord serves webhooks from. The URL is called from the server, so restricting the host
// keeps this from being turned into a generic SSRF primitive.
const ALLOWED_DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

// Validate a Discord webhook URL: https, a known Discord host, and the /api/webhooks/ path shape.
// Returns the normalized URL string.
export const validateDiscordUrl = (raw: string): string => {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        throw new Error('Invalid webhook URL');
    }
    if (parsed.protocol !== 'https:') throw new Error('Discord webhook URL must use https');
    if (!ALLOWED_DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error('URL must be a Discord webhook URL (discord.com)');
    if (!parsed.pathname.startsWith('/api/webhooks/')) throw new Error('URL must be a Discord webhook endpoint (/api/webhooks/...)');
    return parsed.toString();
};

// Render a ProjectEvent as a Discord webhook payload (a single embed). Discord returns 204 on
// success. See https://discord.com/developers/docs/resources/webhook#execute-webhook.
export const buildDiscordRequest = (event: ProjectEvent, webhook: ProjectWebhook): WebhookRequest => {
    const embed: Record<string, unknown> = {
        title: event.title,
        color: EMBED_COLORS[event.severity],
        timestamp: new Date(event.timestamp).toISOString(),
    };
    if (event.description) embed.description = event.description;
    if (event.url) embed.url = event.url;
    if (event.fields?.length) {
        embed.fields = event.fields.map((f) => ({ name: f.name, value: f.value, inline: true }));
    }
    return {
        url: webhook.url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'NSM', embeds: [embed] }),
    };
};

// Render a scenario NotificationMessage as a Discord webhook body (a single embed). Shared by the
// create (POST ?wait=true) and edit (PATCH) paths so an edited message keeps the same layout.
export const buildDiscordNotificationBody = (message: NotificationMessage): string => {
    const embed: Record<string, unknown> = {
        title: message.title,
        color: NOTIFICATION_COLORS[message.color],
        timestamp: new Date(message.timestamp).toISOString(),
    };
    if (message.description) embed.description = message.description;
    if (message.url) embed.url = message.url;
    if (message.fields?.length) embed.fields = message.fields.map((f) => ({ name: f.name, value: f.value, inline: true }));
    return JSON.stringify({ username: 'NSM', embeds: [embed] });
};

// Discord returns the created message (with its id) only when ?wait=true is set on execution.
export const discordSendWithIdUrl = (webhookUrl: string): string => `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;

// The per-message endpoint for editing (PATCH) / deleting (DELETE) a previously-sent message.
export const discordMessageUrl = (webhookUrl: string, messageId: string): string => {
    const base = webhookUrl.split('?')[0].replace(/\/$/, '');
    return `${base}/messages/${messageId}`;
};

export const parseDiscordMessageId = (responseJson: any): string | undefined => (typeof responseJson?.id === 'string' ? responseJson.id : undefined);
