import { getAllowedOrganizationsModel, getAllowedUsersModel } from '@/persistence/allowedEntitiesPersistence';
import { getAllSignedInUsersModel, getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { getOrgsForUser, getPrivateGitHubUserData, revokeGithubAuth } from '@/utils/authUtils';
import { User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { cluster } from '@/cluster/node';
import { areaLog } from '@/utils/log';

const authLog = areaLog('auth');

export const signInUser = async (authToken: string) => {
    try {
        const existingUser = await getUserByAuthTokenModel(authToken);
        const githubUser = await getPrivateGitHubUserData(authToken);
        if (!githubUser) {
            authLog.error({ action: 'signin_failed', reason: 'github_user_fetch_failed' }, 'failed to fetch GitHub user data');
            throw new Error('Failed to fetch GitHub user data');
        }
        const allowedUsers = await getAllowedUsersModel();
        const isUserAllowed = allowedUsers.some((u) => u.id.toLowerCase() === githubUser.login.toLowerCase());
        const isDefaultUser = process.env.VITE_GITHUB_OAUTH_DEFAULT_USER?.toLocaleLowerCase() === githubUser.login.toLowerCase();
        // Org membership is only needed for the org-allow path. Fetch it, but a failure (transient GitHub
        // error, missing org visibility) must not block a user who is already allowed by login / default.
        const usersOrgs = isUserAllowed || isDefaultUser ? [] : await getOrgsForUser(authToken);
        if (usersOrgs === null) authLog.warn({ action: 'org_fetch_failed', login: githubUser.login }, 'failed to fetch GitHub organizations; treating org-allow as no match');
        const allowedOrgs = await getAllowedOrganizationsModel();
        const isOrgAllowed = (usersOrgs || []).some((org) => allowedOrgs.some((allowed) => allowed.id.toLowerCase() === org.login.toLowerCase()));
        if (!isUserAllowed && !isOrgAllowed && !isDefaultUser) {
            authLog.warn({ action: 'signin_denied', githubId: githubUser.id, login: githubUser.login }, `sign-in denied for ${githubUser.login}`);
            if (existingUser) {
                // User is no longer allowed, sign them out
                await signOutUser(authToken);
            }
            return null;
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
        authLog.info({ action: 'user_signed_in', githubId: user.githubId, login: user.name, isUserAllowed, isOrgAllowed, isDefaultUser }, `user ${user.name} signed in`);
        return user;
    } catch (error: any) {
        authLog.error({ action: 'signin_failed', err: error?.message }, 'failed to sign in user');
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
        authLog.error({ action: 'signout_failed', err: e?.message }, 'failed to sign out user');
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
        authLog.error({ action: 'signout_all_failed', err: e?.message }, 'failed to sign out all users');
        throw new Error('Failed to sign out all users: ' + e.message);
    }
};
