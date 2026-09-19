import { getAllSignedInUsersModel, getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { getPrivateGitHubUserData, revokeGithubAuth } from '@/utils/authUtils';
import { User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { cluster } from '@/cluster/node';
import { areaLog, serializeError } from '@/utils/log';

const authLog = areaLog('auth');

// Any GitHub user may establish a session; what they can actually see or do is computed per-request
// from their admin status and team memberships (see authz). A user who is neither an admin nor a
// member of any team simply lands on an empty "no access" state in the UI.
export const signInUser = async (authToken: string) => {
    try {
        const githubUser = await getPrivateGitHubUserData(authToken);
        if (!githubUser) {
            authLog.error({ action: 'signin_failed', reason: 'github_user_fetch_failed' }, 'failed to fetch GitHub user data');
            throw new Error('Failed to fetch GitHub user data');
        }
        const user: User = {
            githubId: githubUser.id,
            name: githubUser.login,
            authToken,
            avatarUrl: githubUser.avatar_url || '',
            created: Date.now(),
            signedIn: true,
        };
        await cluster.propose({ type: OpType.UPSERT_USER, user });
        authLog.info({ action: 'user_signed_in', githubId: user.githubId, login: user.name }, `user ${user.name} signed in`);
        return user;
    } catch (error: any) {
        authLog.error({ action: 'signin_failed', err: serializeError(error) }, 'failed to sign in user');
        throw new Error('Failed to sign in user' + error.message);
    }
};

export const verifyAuthToken = async (token: string): Promise<boolean> => {
    try {
        const user = await getUserByAuthTokenModel(token);
        if (!user) return false;
        return user.signedIn;
    } catch (error) {
        return false;
    }
};

export const signOutUser = async (authToken: string): Promise<void> => {
    try {
        const user = await getUserByAuthTokenModel(authToken);
        if (!user) return;
        await cluster.propose({ type: OpType.UPSERT_USER, user: { ...user, signedIn: false } });
        await revokeGithubAuth(authToken);
        authLog.info({ action: 'user_signed_out', githubId: user.githubId, login: user.name }, `user ${user.name} signed out`);
    } catch (e: any) {
        authLog.error({ action: 'signout_failed', err: serializeError(e) }, 'failed to sign out user');
        throw new Error('Failed to sign out user: ' + e.message);
    }
};

export const signOutAllUsers = async (): Promise<void> => {
    try {
        const users = await getAllSignedInUsersModel();
        authLog.info({ action: 'signout_all', userCount: users.length }, `signing out ${users.length} user(s)`);
        for (const user of users) {
            await signOutUser(user.authToken);
        }
    } catch (e: any) {
        authLog.error({ action: 'signout_all_failed', err: serializeError(e) }, 'failed to sign out all users');
        throw new Error('Failed to sign out all users: ' + e.message);
    }
};
