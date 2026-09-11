import { User } from '@mosaiq/nsm-common/types';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { getGithubLoginUrl } from '@/utils/auth';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';
import { rawApiPostNoHook } from '@/utils/api';

type UserContextType = {
    user: User | null;
    ready: boolean;
    signIn: () => void;
    signOut: () => void;
    startSession: (token: string) => Promise<void>;
};

const LOCAL_STORAGE_TOKEN_KEY = 'nsm-github-token';

const UserContext = createContext<UserContextType | undefined>(undefined);

const UserProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [ready, setReady] = useState(false);

    const tryAutoSignIn = async () => {
        const storedToken = localStorage.getItem(LOCAL_STORAGE_TOKEN_KEY);
        if (storedToken) {
            await startSession(storedToken);
            return true;
        }
        return false;
    };

    const signIn = async () => {
        if (await tryAutoSignIn()) return;
        const loginUrl = getGithubLoginUrl();
        window.location.href = loginUrl;
    };

    const signOut = async () => {
        setUser(null);
        const storedToken = localStorage.getItem(LOCAL_STORAGE_TOKEN_KEY);
        if (!storedToken) return;
        try {
            await rawApiPostNoHook(API_ROUTES.POST_GITHUB_LOGOUT, { token: storedToken }, {}, storedToken);
            localStorage.removeItem(LOCAL_STORAGE_TOKEN_KEY);
            window.location.href = '/';
        } catch (error) {
            console.error('Failed to sign out:', error);
        }
    };

    const startSession = async (token: string) => {
        try {
            localStorage.setItem(LOCAL_STORAGE_TOKEN_KEY, token);
            const res = await rawApiPostNoHook(API_ROUTES.POST_GITHUB_LOGIN, { token }, {}, token);
            if (res) {
                setUser(res);
            } else {
                rawApiPostNoHook(API_ROUTES.POST_GITHUB_LOGOUT, { token }, {}, token);
                setUser(null);
                localStorage.removeItem(LOCAL_STORAGE_TOKEN_KEY);
            }
        } catch (error) {
            console.error('Failed to start session:', error);
        }
    };

    useEffect(() => {
        tryAutoSignIn().finally(() => setReady(true));
    }, []);

    return (
        <UserContext.Provider
            value={{
                user,
                ready,
                signIn,
                signOut,
                startSession,
            }}
        >
            {children}
        </UserContext.Provider>
    );
};

const useUser = () => {
    const context = useContext(UserContext);
    if (context === undefined) {
        throw new Error('useUser must be used within a UserProvider');
    }
    return context;
};

export { UserProvider, useUser };
