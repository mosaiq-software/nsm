import { CdConfig, CdTrigger, Project } from '@mosaiq/nsm-common/types';

// Workflow file path and name are derived from the project id so a single repo can host multiple
// managed workflows (e.g. one per environment) without collision.
export const workflowPathForProject = (projectId: string): string => `.github/workflows/nsm-deploy-${sanitizeFileSegment(projectId)}.yml`;

export const workflowNameForProject = (projectId: string): string => `NSM Deployment - ${projectId}`;

// Repo secret name holding the deploy key. Secret names may only contain [A-Z0-9_] and must not
// start with a digit, so we uppercase and replace anything else with underscore.
export const secretNameForProject = (projectId: string): string => `NSM_DEPLOY_KEY_${projectId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

const sanitizeFileSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '-');

// Build the branches list watched by a trigger, defaulting to the single deploy branch.
const watchedBranches = (cd: CdConfig): string[] => (cd.branches && cd.branches.length > 0 ? cd.branches : [cd.branch]);

const yamlStringList = (values: string[]): string => `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;

// Generate a managed GitHub Actions workflow that calls back into NSM's deploy webhook. The deploy
// key travels only as an encrypted repo secret; the project id and NSM base URL are baked into the
// YAML (not sensitive). PR-merge deploys are guarded by an `if:` so closed-but-unmerged PRs are
// ignored while every other selected event still deploys.
export const generateWorkflowYaml = (project: Project, cd: CdConfig, deployUrlBase: string): string => {
    const secretName = cd.secretName;
    const on: string[] = [];

    const wantsPush = cd.triggers.includes(CdTrigger.PUSH);
    const wantsTag = cd.triggers.includes(CdTrigger.TAG);
    if (wantsPush || wantsTag) {
        on.push('  push:');
        if (wantsPush) on.push(`    branches: ${yamlStringList(watchedBranches(cd))}`);
        if (wantsTag) on.push(`    tags: ${yamlStringList([cd.tagPattern || 'v*'])}`);
    }
    if (cd.triggers.includes(CdTrigger.PR_MERGE)) {
        on.push('  pull_request:');
        on.push('    types: [closed]');
        on.push(`    branches: ${yamlStringList(watchedBranches(cd))}`);
    }
    if (cd.triggers.includes(CdTrigger.RELEASE)) {
        on.push('  release:');
        on.push('    types: [published]');
    }
    if (cd.triggers.includes(CdTrigger.MANUAL)) {
        on.push('  workflow_dispatch:');
    }
    if (cd.triggers.includes(CdTrigger.SCHEDULE) && cd.cron) {
        on.push('  schedule:');
        on.push(`    - cron: ${JSON.stringify(cd.cron)}`);
    }

    // Only merged pull requests should deploy; all other event types pass through unguarded.
    const prGuard = cd.triggers.includes(CdTrigger.PR_MERGE)
        ? "    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.merged == true }}\n"
        : '';

    const deployUrl = `${deployUrlBase.replace(/\/$/, '')}/deploy/${project.id}/`;

    return (
        `name: ${JSON.stringify(workflowNameForProject(project.id))}\n` +
        `\n` +
        `on:\n${on.join('\n')}\n` +
        `\n` +
        `jobs:\n` +
        `  deploy:\n` +
        `    runs-on: ubuntu-latest\n` +
        prGuard +
        `    steps:\n` +
        `      - name: Trigger NSM deployment\n` +
        `        run: curl -fsSL --retry 3 "${deployUrl}\${{ secrets.${secretName} }}"\n`
    );
};
