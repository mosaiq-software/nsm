import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

// web-push must never hit the network in tests: stub the signer and capture sends.
const h = vi.hoisted(() => ({ sendNotification: vi.fn(async () => {}) }));
const sendNotification = h.sendNotification;
vi.mock('web-push', () => ({
    default: {
        setVapidDetails: vi.fn(),
        generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
        sendNotification: h.sendNotification,
    },
}));
vi.mock('@/cluster/node', () => ({ cluster: { isLeader: () => true, propose: vi.fn() } }));
// Access is resolved live from GitHub in production; drive it directly here.
vi.mock('@/controllers/authz', () => ({ getEffectiveCapabilitiesForProject: vi.fn() }));

import { sendDeploymentNotification, getProjectNotificationEnabled, setProjectNotification } from '@/controllers/pushController';
import { getEffectiveCapabilitiesForProject } from '@/controllers/authz';
import { createUserModel } from '@/persistence/userPersistence';
import { createPushSubscriptionModel } from '@/persistence/pushSubscriptionPersistence';
import { muteProjectModel } from '@/persistence/notificationMutePersistence';
import { Capability, DeploymentState, Project, User } from '@mosaiq/nsm-common/types';

const project: Project = { id: 'p1', repoOwner: 'o', repoName: 'r' } as Project;

const seedUser = (githubId: string, name: string) =>
    createUserModel({ githubId, name, authToken: `tok-${githubId}`, avatarUrl: '', created: Date.now(), signedIn: true } as User);

const seedSub = (githubId: string, endpoint: string) =>
    createPushSubscriptionModel(githubId, { endpoint, keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` } });

const sentEndpoints = () => sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint).sort();

beforeEach(async () => {
    await resetDb();
    sendNotification.mockClear();
    (getEffectiveCapabilitiesForProject as Mock).mockReset();
});

describe('sendDeploymentNotification recipient filtering', () => {
    it('sends only to subscribers who have not muted the project and still hold VIEW', async () => {
        await seedUser('a', 'alice');
        await seedUser('b', 'bob');
        await seedUser('c', 'carol');
        await seedSub('a', 'eA');
        await seedSub('b', 'eB');
        await seedSub('c', 'eC');

        // carol has lost access; alice and bob retain VIEW.
        (getEffectiveCapabilitiesForProject as Mock).mockImplementation(async (user: User) => (user.githubId === 'c' ? [] : [Capability.VIEW]));

        // bob muted this project.
        await muteProjectModel('b', 'p1');

        await sendDeploymentNotification(project, DeploymentState.FAILED);

        expect(sentEndpoints()).toEqual(['eA']);
    });

    it('delivers to every endpoint of an eligible user', async () => {
        await seedUser('a', 'alice');
        await seedSub('a', 'e1');
        await seedSub('a', 'e2');
        (getEffectiveCapabilitiesForProject as Mock).mockResolvedValue([Capability.VIEW]);

        await sendDeploymentNotification(project, DeploymentState.HEALTHY);

        expect(sentEndpoints()).toEqual(['e1', 'e2']);
    });

    it('skips subscriptions with no matching user record', async () => {
        await seedSub('ghost', 'eGhost');
        (getEffectiveCapabilitiesForProject as Mock).mockResolvedValue([Capability.VIEW]);

        await sendDeploymentNotification(project, DeploymentState.DEPLOYED);

        expect(sendNotification).not.toHaveBeenCalled();
    });
});

describe('project notification preferences (opt-out)', () => {
    it('defaults to enabled and toggles via mute/unmute', async () => {
        await seedUser('a', 'alice');
        expect(await getProjectNotificationEnabled('tok-a', 'p1')).toBe(true);

        await setProjectNotification('tok-a', 'p1', false);
        expect(await getProjectNotificationEnabled('tok-a', 'p1')).toBe(false);

        await setProjectNotification('tok-a', 'p1', true);
        expect(await getProjectNotificationEnabled('tok-a', 'p1')).toBe(true);
    });

    it('returns false for an unknown auth token', async () => {
        expect(await getProjectNotificationEnabled('nope', 'p1')).toBe(false);
        expect(await setProjectNotification('nope', 'p1', false)).toBe(false);
    });
});
