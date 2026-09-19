import { QueryClient } from '@tanstack/react-query';

// Single app-wide client. Sensible defaults: modest stale time so navigations reuse cache, no
// window-focus refetch storms, and a single retry (the API helper already swallows/logs errors).
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});
