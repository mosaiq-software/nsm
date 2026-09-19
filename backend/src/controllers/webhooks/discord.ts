import { ProjectEvent, ProjectEventSeverity, ProjectWebhook } from '@mosaiq/nsm-common/types';
import type { WebhookRequest } from './registry';

// Discord embed accent color per severity (standard Discord palette).
const EMBED_COLORS: Record<ProjectEventSeverity, number> = {
    [ProjectEventSeverity.INFO]: 0x5865f2, // blurple
    [ProjectEventSeverity.SUCCESS]: 0x57f287, // green
    [ProjectEventSeverity.WARNING]: 0xe67e22, // orange
    [ProjectEventSeverity.ERROR]: 0xed4245, // red
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
