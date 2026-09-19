import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { CdTrigger, DeploymentState, Project } from '@mosaiq/nsm-common/types';
import { sha256Hex } from '@/utils/hash';

vi.mock('@/controllers/projectController', () => ({ getProject: vi.fn() }));
vi.mock('@/controllers/githubNotifications', () => ({ dispatchGithubEvent: vi.fn() }));

import { handleGithubWebhook } from '@/controllers/githubWebhookController';
import { getProject } from '@/controllers/projectController';
import { dispatchGithubEvent } from '@/controllers/githubNotifications';

const getProjectMock = getProject as unknown as Mock;

const TOKEN = 'sekret-token';
const project = (over: Partial<Project> = {}): Project => ({
    id: 'p1',
    repoOwner: 'o',
    repoName: 'r',
    state: DeploymentState.READY,
    githubWebhook: { hookId: 1, tokenHash: sha256Hex(TOKEN) },
    cicd: { managed: true, branch: 'main', triggers: [CdTrigger.PUSH], setupAt: 0 },
    ...over,
});

beforeEach(() => {
    getProjectMock.mockReset();
    (dispatchGithubEvent as unknown as Mock).mockReset();
});

describe('handleGithubWebhook', () => {
    it('404s when the project has no shared webhook provisioned', async () => {
        getProjectMock.mockResolvedValue(project({ githubWebhook: undefined }));
        const out = await handleGithubWebhook('p1', TOKEN, 'push', {});
        expect(out.status).toBe(404);
        expect(out.deploy).toBe(false);
    });

    it('rejects an invalid path token', async () => {
        getProjectMock.mockResolvedValue(project());
        const out = await handleGithubWebhook('p1', 'wrong', 'push', { ref: 'refs/heads/main' });
        expect(out.status).toBe(401);
        expect(out.deploy).toBe(false);
        expect(dispatchGithubEvent).not.toHaveBeenCalled();
    });

    it('acknowledges the ping event without deploying', async () => {
        getProjectMock.mockResolvedValue(project());
        const out = await handleGithubWebhook('p1', TOKEN, 'ping', {});
        expect(out.status).toBe(200);
        expect(out.deploy).toBe(false);
    });

    it('enqueues a deploy on a matching push and always dispatches notifications', async () => {
        getProjectMock.mockResolvedValue(project());
        const out = await handleGithubWebhook('p1', TOKEN, 'push', { ref: 'refs/heads/main' });
        expect(out.deploy).toBe(true);
        expect(dispatchGithubEvent).toHaveBeenCalledTimes(1);
    });

    it('does not deploy on a push to an unwatched branch', async () => {
        getProjectMock.mockResolvedValue(project());
        const out = await handleGithubWebhook('p1', TOKEN, 'push', { ref: 'refs/heads/dev' });
        expect(out.deploy).toBe(false);
        expect(out.status).toBe(200);
    });

    it('dispatches notifications even when no managed CD exists', async () => {
        getProjectMock.mockResolvedValue(project({ cicd: undefined }));
        const out = await handleGithubWebhook('p1', TOKEN, 'pull_request', { action: 'opened' });
        expect(out.deploy).toBe(false);
        expect(dispatchGithubEvent).toHaveBeenCalledTimes(1);
    });
});
