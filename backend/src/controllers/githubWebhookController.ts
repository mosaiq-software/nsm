import { CdConfig, CdTrigger, Project } from '@mosaiq/nsm-common/types';
import { getProject } from '@/controllers/projectController';
import { dispatchGithubEvent } from '@/controllers/githubNotifications';
import { hashEquals } from '@/utils/hash';
import { areaLog } from '@/utils/log';

const hookLog = areaLog('github-webhook');

// Outcome of evaluating an inbound delivery. `status`/`message` are the HTTP response to send back to
// GitHub; `deploy` is true only when the event matches the project's configured CD conditions.
export interface WebhookOutcome {
    status: number;
    message: string;
    deploy: boolean;
}

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

// Verify the delivery path token against the project's stored token hash. The shared webhook is
// authenticated by this token (hashed at rest) rather than a GitHub HMAC signature.
const verifyToken = (project: Project, token: string): boolean => !!project.githubWebhook && hashEquals(token, project.githubWebhook.tokenHash);

// Authenticate and evaluate an inbound GitHub webhook delivery for a project. Verifies the path
// token, fans the event out to the notification dispatcher (fire-and-forget), and returns whether
// the event should enqueue a CD deploy (the caller performs the enqueue).
export const handleGithubWebhook = async (projectId: string, token: string, eventType: string | undefined, payload: any): Promise<WebhookOutcome> => {
    const project = await getProject(projectId);
    if (!project?.githubWebhook) return { status: 404, message: 'No webhook for project', deploy: false };

    if (!verifyToken(project, token)) {
        hookLog.warn({ action: 'github_webhook_bad_token', projectId, eventType }, `rejected webhook with bad token for ${projectId}`);
        return { status: 401, message: 'Invalid token', deploy: false };
    }

    // GitHub sends a `ping` when the hook is created; acknowledge it without acting.
    if (eventType === 'ping') return { status: 200, message: 'pong', deploy: false };

    // Fan out to Discord notification scenarios independently of CD (fire-and-forget, leader-only).
    void dispatchGithubEvent(project, eventType || '', payload);

    const cd = project.cicd;
    if (cd?.managed && eventTriggersDeploy(cd, eventType || '', payload)) {
        hookLog.info({ action: 'github_webhook_deploy', projectId, eventType }, `webhook matched CD conditions for ${projectId}`);
        return { status: 200, message: 'Deploy enqueued', deploy: true };
    }

    hookLog.debug({ action: 'github_webhook_ignored', projectId, eventType }, `webhook did not match CD conditions for ${projectId}`);
    return { status: 200, message: 'Accepted', deploy: false };
};
