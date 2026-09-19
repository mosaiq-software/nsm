import { getRecentDeployDurationsModel } from '@/persistence/projectInstancePersistence';
import { config } from '@/config';

export interface ProjectDeployAverage {
    // Mean of recent successful deploy durations (ms), or undefined when the project has no history.
    deployMs?: number;
    // How many past deploys backed the average (0 = no history).
    sampleCount: number;
}

// Per-project average of recent successful deploy durations. This is the single source of truth for
// "how long does this project take to deploy" - both the deploy-queue ETA math (statusController)
// and the project deploy page read from here so their numbers always match.
export const getProjectDeployAverage = async (projectId: string): Promise<ProjectDeployAverage> => {
    const durations = await getRecentDeployDurationsModel(projectId, config.deployDurationSampleSize);
    if (!durations.length) return { deployMs: undefined, sampleCount: 0 };
    return { deployMs: durations.reduce((a, b) => a + b, 0) / durations.length, sampleCount: durations.length };
};
