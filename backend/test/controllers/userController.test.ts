import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { resetDb } from '../helpers/db';

vi.mock('@/cluster/node', () => ({ cluster: { propose: vi.fn(), isLeader: () => true } }));
vi.mock('@/utils/authUtils', () => ({ getPrivateGitHubUserData: vi.fn(), revokeGithubAuth: vi.fn() }));

import { cluster } from '@/cluster/node';
import { applyOp } from '@/cluster/stateMachine';
import { getPrivateGitHubUserData, revokeGithubAuth } from '@/utils/authUtils';
import { signInUser, verifyAuthToken, signOutUser } from '@/controllers/userController';
import { getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';

const propose = cluster.propose as unknown as Mock;
const mockUser = getPrivateGitHubUserData as unknown as Mock;
const mockRevoke = revokeGithubAuth as unknown as Mock;
let idx = 0;

beforeEach(async () => {
    await resetDb();
    idx = 0;
    delete process.env.VITE_GITHUB_OAUTH_DEFAULT_USER;
    propose.mockReset();
    propose.mockImplementation(async (op: any) => applyOp(op, ++idx));
    mockUser.mockReset();
    mockRevoke.mockReset();
});

describe('signInUser', () => {
    // Access control is now computed per-request from admin/team membership; sign-in itself succeeds
    // for any valid GitHub user and simply establishes a session.
    it('signs in any authenticated GitHub user', async () => {
        mockUser.mockResolvedValue({ id: 'g1', login: 'octocat', avatar_url: '' });
        const user = await signInUser('tok');
        expect(user?.name).toBe('octocat');
        expect((await getUserByAuthTokenModel('tok'))?.signedIn).toBe(true);
    });

    it('throws when the GitHub user cannot be fetched', async () => {
        mockUser.mockResolvedValue(null);
        await expect(signInUser('tok')).rejects.toThrow();
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
