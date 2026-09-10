export const getGitSshUri = (repoOwner: string, repoName: string): string => {
    return `git@github.com:${repoOwner}/${repoName}.git`;
};

export const getGitHttpsUri = (repoOwner: string, repoName: string): string => {
    return `https://github.com/${repoOwner}/${repoName}.git`;
};
