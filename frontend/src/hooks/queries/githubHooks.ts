import { useQuery } from '@tanstack/react-query';
import { useAPI } from '@/utils/api';
import { queryKeys } from '@/query/keys';
import { API_ROUTES } from '@mosaiq/nsm-common/routes';

// Repositories the GitHub App can access for the given owner.
export const useGithubRepos = (owner: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.githubRepos(owner),
        queryFn: async () => (await api.get(API_ROUTES.GET_GITHUB_REPOS, {}, { owner })) ?? [],
        enabled: !!api.token && !!owner && enabled,
    });
};

// Branches of the given owner/repo.
export const useGithubBranches = (owner: string, repo: string, enabled = true) => {
    const api = useAPI();
    return useQuery({
        queryKey: queryKeys.githubBranches(owner, repo),
        queryFn: async () => (await api.get(API_ROUTES.GET_GITHUB_BRANCHES, {}, { owner, repo })) ?? [],
        enabled: !!api.token && !!owner && !!repo && enabled,
    });
};
