import * as crypto from 'crypto';
import { CdConfig, CdTrigger } from '@mosaiq/nsm-common/types';
import { getProject } from '@/controllers/projectController';
import { areaLog } from '@/utils/log';

const hookLog = areaLog('github-webhook');

// Outcome of evaluating an inbound delivery. `status`/`message` are the HTTP response to send back to
// GitHub; `deploy` is true only when the event matches the project's configured CD conditions.
export interface WebhookOutcome {
    status: number;
    message: string;
    deploy: boolean;
}

// Constant-time comparison of the delivered X-Hub-Signature-256 header against an HMAC-SHA256 of the
// raw body keyed by the webhook secret.
const verifySignature = (secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean => {
    if (!signatureHeader) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// The branches a project watches for PUSH / PR_MERGE, defaulting to the single deploy branch.
const watchedBranches = (cd: CdConfig): string[] => (cd.branches && cd.branches.length > 0 ? cd.branches : [cd.branch]);

// Match a git tag against a glob pattern (only `*` and `?` are treated as wildcards).
const tagMatches = (tag: string, pattern: string): boolean => {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(tag);
};

// Decide whether a parsed GitHub event satisfies any of the project's configured CD triggers.
const eventTriggersDeploy = (cd: CdConfig, eventType: string, payload: any): boolean => {
    const branches = watchedBranches(cd);
    switch (eventType) {
        case 'push': {
            const ref: string = payload?.ref || '';
            if (ref.startsWith('refs/heads/') && cd.triggers.includes(CdTrigger.PUSH)) {
                return branches.includes(ref.slice('refs/heads/'.length));
            }
            if (ref.startsWith('refs/tags/') && cd.triggers.includes(CdTrigger.TAG)) {
                return tagMatches(ref.slice('refs/tags/'.length), cd.tagPattern || 'v*');
            }
            return false;
        }
        case 'pull_request': {
            if (!cd.triggers.includes(CdTrigger.PR_MERGE)) return false;
            const merged = payload?.action === 'closed' && payload?.pull_request?.merged === true;
            return merged && branches.includes(payload?.pull_request?.base?.ref);
        }
        case 'release':
            return cd.triggers.includes(CdTrigger.RELEASE) && payload?.action === 'published';
        default:
            return false;
    }
};

// Verify and evaluate an inbound GitHub webhook delivery for a project. Returns whether the event
// should enqueue a deploy; the caller performs the actual enqueue.
export const handleGithubWebhook = async (projectId: string, eventType: string | undefined, signatureHeader: string | undefined, rawBody: Buffer, payload: any): Promise<WebhookOutcome> => {
    const project = await getProject(projectId);
    const cd = project?.cicd;
    if (!project || !cd?.managed) return { status: 404, message: 'No managed CD for project', deploy: false };

    if (!verifySignature(cd.webhookSecret, rawBody, signatureHeader)) {
        hookLog.warn({ action: 'github_webhook_bad_signature', projectId, eventType }, `rejected webhook with bad signature for ${projectId}`);
        return { status: 401, message: 'Invalid signature', deploy: false };
    }

    // GitHub sends a `ping` when the hook is created; acknowledge it without deploying.
    if (eventType === 'ping') return { status: 200, message: 'pong', deploy: false };

    if (eventTriggersDeploy(cd, eventType || '', payload)) {
        hookLog.info({ action: 'github_webhook_deploy', projectId, eventType }, `webhook matched CD conditions for ${projectId}`);
        return { status: 200, message: 'Deploy enqueued', deploy: true };
    }

    hookLog.debug({ action: 'github_webhook_ignored', projectId, eventType }, `webhook did not match CD conditions for ${projectId}`);
    return { status: 200, message: 'Ignored', deploy: false };
};
