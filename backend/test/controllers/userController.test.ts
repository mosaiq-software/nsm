import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true } }));
vi.mock('@/utils/authUtils', () => ({ getPrivateGitHubUserData: vi.fn(), getOrgsForUser: vi.fn(), revokeGithubAuth: vi.fn() }));

import { cluster } from '@/cluster/node';
import { applyOp } from '@/cluster/stateMachine';
import { getPrivateGitHubUserData, getOrgsForUser, revokeGithubAuth } from '@/utils/authUtils';
import { signInUser, verifyAuthToken, signOutUser } from '@/controllers/userController';
import { createAllowedEntityModel } from '@/persistence/allowedEntitiesPersistence';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { AllowedEntityType, User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';

const propose = cluster.propose as unknown as Mock;
const mockUser = getPrivateGitHubUserData as unknown as Mock;
const mockOrgs = getOrgsForUser as unknown as Mock;
const mockRevoke = revokeGithubAuth as unknown as Mock;
let idx = 0;

beforeEach(async () => {
    await resetDb();
    idx = 0;
    delete process.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
    propose.mockReset();
    propose.mockImplementation(async (op: any) => applyOp(op, ++idx));
    mockUser.mockReset();
    mockOrgs.mockReset().mockResolvedValue([]);
    mockRevoke.mockReset();
});

describe('signInUser', () => {
    it('signs in a user allowed by username', async () => {
        await createAllowedEntityModel({ id: 'octocat', type: AllowedEntityType.USER, avatarUrl: '' });
        mockUser.mockResolvedValue({ id: 'g1', login: 'octocat', avatar_url: '' });
        const user = await signInUser('tok');
        expect(user?.name).toBe('octocat');
        expect((await getUserByAuthTokenModel('tok'))?.signedIn).toBe(true);
    });

    it('signs in a user allowed by organization membership', async () => {
        await createAllowedEntityModel({ id: 'myorg', type: AllowedEntityType.ORGANIZATION, avatarUrl: '' });
        mockUser.mockResolvedValue({ id: 'g2', login: 'stranger', avatar_url: '' });
        mockOrgs.mockResolvedValue([{ login: 'myorg' }]);
        expect(await signInUser('tok')).not.toBeNull();
    });

    it('signs in the default user even when org lookup fails', async () => {
        process.env.VITE_GITHUB_OAUTH_DEFAULT_USER = 'owner1';
        mockUser.mockResolvedValue({ id: 'g4', login: 'owner1', avatar_url: '' });
        mockOrgs.mockResolvedValue(null);
        expect(await signInUser('tok')).not.toBeNull();
    });

    it('signs in a user allowed by username even when org lookup fails', async () => {
        await createAllowedEntityModel({ id: 'octocat', type: AllowedEntityType.USER, avatarUrl: '' });
        mockUser.mockResolvedValue({ id: 'g5', login: 'octocat', avatar_url: '' });
        mockOrgs.mockResolvedValue(null);
        expect(await signInUser('tok')).not.toBeNull();
    });

    it('denies (without throwing) a non-allowed user when org lookup fails', async () => {
        await createAllowedEntityModel({ id: 'myorg', type: AllowedEntityType.ORGANIZATION, avatarUrl: '' });
        mockUser.mockResolvedValue({ id: 'g6', login: 'stranger', avatar_url: '' });
        mockOrgs.mockResolvedValue(null);
        expect(await signInUser('tok')).toBeNull();
    });

    it('denies a disallowed user, and signs out an existing session that lost access', async () => {
        // Pre-existing signed-in session.
        await applyOp({ type: OpType.UPSERT_USER, user: { githubId: 'g3', name: 'ex', authToken: 'tok', avatarUrl: '', created: 1, signedIn: true } as User }, ++idx);
        mockUser.mockResolvedValue({ id: 'g3', login: 'ex', avatar_url: '' });
        const result = await signInUser('tok');
        expect(result).toBeNull();
        expect((await getUserByAuthTokenModel('tok'))?.signedIn).toBe(false);
        expect(mockRevoke).toHaveBeenCalledWith('tok');
    });
});

describe('verifyAuthToken', () => {
    it('reflects the signedIn flag', async () => {
        await applyOp({ type: OpType.UPSERT_USER, user: { githubId: 'g', name: 'n', authToken: 'tok', avatarUrl: '', created: 1, signedIn: true } as User }, ++idx);
        expect(await verifyAuthToken('tok')).toBe(true);
        expect(await verifyAuthToken('missing')).toBe(false);
        await signOutUser('tok');
        expect(await verifyAuthToken('tok')).toBe(false);
    });
});
