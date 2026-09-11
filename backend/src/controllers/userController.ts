import { getAllowedOrganizationsModel, getAllowedUsersModel } from '@/persistence/allowedEntitiesPersistence';
import { getAllSignedInUsersModel, getUserByAuthTokenModel } from '@/persistence/userPersistence';
import { getOrgsForUser, getPrivateGitHubUserData, revokeGithubAuth } from '@/utils/authUtils';
import { User } from '@mosaiq/nsm-common/types';
import { OpType } from '@mosaiq/nsm-common/clusterOps';
import { cluster } from '@/cluster/node';

export const signInUser = async (authToken: string) => {
    try {
        const existingUser = await getUserByAuthTokenModel(authToken);
        const githubUser = await getPrivateGitHubUserData(authToken);
        if (!githubUser) {
            console.error('Failed to fetch GitHub user data');
            throw new Error('Failed to fetch GitHub user data');
        }
        const usersOrgs = await getOrgsForUser(authToken);
        if (!usersOrgs) {
            console.error('Failed to fetch GitHub organizations');
            throw new Error('Failed to fetch GitHub organizations');
        }
        const allowedUsers = await getAllowedUsersModel();
        const allowedOrgs = await getAllowedOrganizationsModel();
        const isUserAllowed = allowedUsers.some((u) => u.id.toLowerCase() === githubUser.login.toLowerCase());
        const isOrgAllowed = usersOrgs.some((org) => allowedOrgs.some((allowed) => allowed.id.toLowerCase() === org.login.toLowerCase()));
        if (!isUserAllowed && !isOrgAllowed && process.env.VITE_GITHUB_OAUTH_DEFAULT_USER?.toLocaleLowerCase() !== githubUser.login.toLowerCase()) {
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
        return user;
    } catch (error: any) {
        console.error('Failed to sign in user:', error);
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
    } catch (e: any) {
        console.error('Failed to sign out user:', e);
        throw new Error('Failed to sign out user: ' + e.message);
    }
};

export const signOutAllUsers = async (): Promise<void> => {
    try {
        const users = await getAllSignedInUsersModel();
        for (const user of users) {
            await signOutUser(user.authToken);
        }
    } catch (e: any) {
        console.error('Failed to sign out all users:', e);
        throw new Error('Failed to sign out all users: ' + e.message);
    }
};
