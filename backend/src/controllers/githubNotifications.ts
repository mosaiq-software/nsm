import crypto from 'crypto';
import { DiscordMessageRef, GITHUB_TERMINAL_SUBEVENTS, GithubScenario, GithubScenarioConfig, Project, ProjectWebhook, ProjectWebhookType } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { getWebhooksByProjectModel } from '@/persistence/projectWebhookPersistence';
import { getDiscordMessageRefByKeyModel } from '@/persistence/discordMessageRefPersistence';
import { deleteScenarioMessage, editScenarioMessage, sendScenarioMessage } from '@/controllers/webhookController';
import { NotificationMessage } from '@/controllers/webhooks/registry';
import { cluster } from '@/cluster/node';
import { areaLog, serializeError } from '@/utils/log';

const notifLog = areaLog('github-notifications');

// A raw GitHub delivery normalized to a scenario + sub-event, the stable subject key used to track a
// message across its lifecycle, an optional branch (for filtering), and the rendered message.
interface NormalizedEvent {
    scenario: GithubScenario;
    subEvent: string;
    externalKey: string;
    branch?: string;
    message: NotificationMessage;
}

const branchFromRef = (ref: string | undefined): string | undefined => (ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined);

// Map a raw GitHub webhook (eventType, payload) onto a normalized scenario event, or null when the
// event is not one NSM surfaces as a notification.
const normalizeEvent = (eventType: string, payload: any): NormalizedEvent | null => {
    const now = Date.now();
    const repo: string | undefined = payload?.repository?.full_name;
    const repoField = repo ? [{ name: 'Repository', value: repo }] : undefined;

    switch (eventType) {
        case 'pull_request': {
            const pr = payload?.pull_request;
            if (!pr) return null;
            const action = payload?.action;
            let subEvent: string | null = null;
            if (action === 'opened') subEvent = 'opened';
            else if (action === 'closed') subEvent = pr.merged ? 'merged' : 'closed';
            else return null;
            const colors = { opened: 'open', merged: 'success', closed: 'neutral' } as const;
            const verb = { opened: 'opened', merged: 'merged', closed: 'closed' }[subEvent]!;
            return {
                scenario: GithubScenario.PULL_REQUEST,
                subEvent,
                externalKey: `pr:${pr.number}`,
                branch: pr.base?.ref,
                message: {
                    title: `PR #${pr.number}: ${pr.title}`,
                    description: `${verb} by ${pr.user?.login ?? 'unknown'} — \`${pr.head?.ref}\` → \`${pr.base?.ref}\``,
                    url: pr.html_url,
                    color: colors[subEvent as keyof typeof colors],
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        case 'pull_request_review': {
            if (payload?.action !== 'submitted') return null;
            const pr = payload?.pull_request;
            const state: string = (payload?.review?.state || '').toLowerCase();
            let subEvent: string | null = null;
            if (state === 'approved') subEvent = 'approved';
            else if (state === 'changes_requested') subEvent = 'changes_requested';
            else return null;
            return {
                scenario: GithubScenario.PULL_REQUEST,
                subEvent,
                externalKey: `pr:${pr?.number}`,
                branch: pr?.base?.ref,
                message: {
                    title: `PR #${pr?.number}: ${pr?.title}`,
                    description: subEvent === 'approved' ? `Approved by ${payload?.review?.user?.login ?? 'a reviewer'}` : `Changes requested by ${payload?.review?.user?.login ?? 'a reviewer'}`,
                    url: pr?.html_url,
                    color: subEvent === 'approved' ? 'success' : 'danger',
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        case 'issues': {
            const issue = payload?.issue;
            const action = payload?.action;
            if (!issue || (action !== 'opened' && action !== 'closed')) return null;
            return {
                scenario: GithubScenario.ISSUE,
                subEvent: action,
                externalKey: `issue:${issue.number}`,
                message: {
                    title: `Issue #${issue.number}: ${issue.title}`,
                    description: `${action} by ${(action === 'opened' ? issue.user?.login : payload?.sender?.login) ?? 'unknown'}`,
                    url: issue.html_url,
                    color: action === 'opened' ? 'open' : 'neutral',
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        case 'release': {
            const release = payload?.release;
            if (payload?.action !== 'published' || !release) return null;
            return {
                scenario: GithubScenario.RELEASE,
                subEvent: 'published',
                externalKey: `release:${release.id}`,
                message: {
                    title: `Release ${release.name || release.tag_name}`,
                    description: `Published by ${release.author?.login ?? 'unknown'}`,
                    url: release.html_url,
                    color: 'success',
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        case 'push': {
            const branch = branchFromRef(payload?.ref);
            if (!branch || payload?.deleted) return null;
            const commits: any[] = Array.isArray(payload?.commits) ? payload.commits : [];
            const head = payload?.head_commit;
            return {
                scenario: GithubScenario.PUSH,
                subEvent: 'pushed',
                externalKey: `push:${branch}`,
                branch,
                message: {
                    title: `Push to ${branch}`,
                    description: `${commits.length} commit(s) by ${payload?.pusher?.name ?? 'unknown'}${head?.message ? ` — ${head.message.split('\n')[0]}` : ''}`,
                    url: payload?.compare,
                    color: 'open',
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        case 'workflow_run': {
            const run = payload?.workflow_run;
            if (payload?.action !== 'completed' || !run) return null;
            const conclusion: string = (run.conclusion || '').toLowerCase();
            let subEvent: string | null = null;
            if (conclusion === 'failure') subEvent = 'failed';
            else if (conclusion === 'success') subEvent = 'succeeded';
            else return null;
            return {
                scenario: GithubScenario.WORKFLOW_RUN,
                subEvent,
                externalKey: `run:${run.id}`,
                branch: run.head_branch,
                message: {
                    title: `Workflow ${subEvent === 'failed' ? 'failed' : 'succeeded'}: ${run.name}`,
                    description: `${run.name} on \`${run.head_branch}\` ${subEvent === 'failed' ? 'failed' : 'completed successfully'}`,
                    url: run.html_url,
                    color: subEvent === 'failed' ? 'danger' : 'success',
                    fields: repoField,
                    timestamp: now,
                },
            };
        }
        default:
            return null;
    }
};

// Whether a scenario config matches this event and passes its optional branch filter.
const configMatches = (config: GithubScenarioConfig, evt: NormalizedEvent): boolean => {
    if (config.scenario !== evt.scenario) return false;
    if (!config.on.includes(evt.subEvent)) return false;
    if (config.branches?.length && evt.branch && !config.branches.includes(evt.branch)) return false;
    return true;
};

const upsertRef = async (projectId: string, webhookId: string, evt: NormalizedEvent, messageId: string, existing: DiscordMessageRef | null): Promise<void> => {
    const now = Date.now();
    const ref: DiscordMessageRef = {
        id: existing?.id ?? crypto.randomUUID(),
        projectId,
        webhookId,
        scenario: evt.scenario,
        externalKey: evt.externalKey,
        channelMessageId: messageId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    await cluster.propose({ type: OpType.UPSERT_DISCORD_MESSAGE_REF, ref });
};

// Apply one webhook's scenario config to a normalized event, honoring the configured lifecycle:
// 'new' always posts; 'update' edits a tracked message (or posts + tracks); 'update_then_delete'
// deletes the tracked message on a terminal sub-event and otherwise behaves like 'update'.
const applyToWebhook = async (project: Project, webhook: ProjectWebhook, config: GithubScenarioConfig, evt: NormalizedEvent): Promise<void> => {
    if (config.lifecycle === 'new') {
        await sendScenarioMessage(webhook, evt.message);
        return;
    }

    const existing = await getDiscordMessageRefByKeyModel(webhook.id, evt.scenario, evt.externalKey);
    const terminal = (GITHUB_TERMINAL_SUBEVENTS[evt.scenario] || []).includes(evt.subEvent);

    if (config.lifecycle === 'update_then_delete' && terminal) {
        if (existing) {
            await deleteScenarioMessage(webhook, existing.channelMessageId);
            await cluster.propose({ type: OpType.DELETE_DISCORD_MESSAGE_REF, refId: existing.id });
        }
        return;
    }

    if (existing) {
        const ok = await editScenarioMessage(webhook, existing.channelMessageId, evt.message);
        // If the edit failed (e.g. the message was manually deleted), fall back to posting a new one.
        if (ok) await upsertRef(project.id, webhook.id, evt, existing.channelMessageId, existing);
        else {
            const id = await sendScenarioMessage(webhook, evt.message);
            if (id) await upsertRef(project.id, webhook.id, evt, id, existing);
        }
        return;
    }

    const id = await sendScenarioMessage(webhook, evt.message);
    if (id) await upsertRef(project.id, webhook.id, evt, id, null);
};

// Fan a raw GitHub webhook delivery out to every enabled Discord webhook whose GitHub scenario
// config matches, applying each one's message lifecycle. Leader-only and fire-and-forget: callers
// `void` this and it never rejects (all failures are swallowed and logged).
export const dispatchGithubEvent = async (project: Project, eventType: string, payload: any): Promise<void> => {
    try {
        if (!cluster.isLeader()) return;
        const evt = normalizeEvent(eventType, payload);
        if (!evt) return;

        const webhooks = await getWebhooksByProjectModel(project.id);
        const jobs: Promise<void>[] = [];
        for (const webhook of webhooks) {
            if (!webhook.enabled || webhook.type !== ProjectWebhookType.DISCORD) continue;
            const config = webhook.githubScenarios?.find((c) => configMatches(c, evt));
            if (!config) continue;
            jobs.push(applyToWebhook(project, webhook, config, evt));
        }
        if (!jobs.length) return;
        const results = await Promise.allSettled(jobs);
        const failed = results.filter((r) => r.status === 'rejected').length;
        notifLog.info({ action: 'github_notification_dispatched', projectId: project.id, scenario: evt.scenario, subEvent: evt.subEvent, targetCount: jobs.length, failed }, `dispatched ${evt.scenario}/${evt.subEvent} to ${jobs.length} webhook(s) for ${project.id}`);
    } catch (e: any) {
        notifLog.error({ action: 'github_notification_failed', projectId: project.id, eventType, err: serializeError(e) }, 'failed to dispatch GitHub notification');
    }
};
