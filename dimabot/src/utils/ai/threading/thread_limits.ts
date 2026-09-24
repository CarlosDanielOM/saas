export interface ThreadLimits {
    maxChannelThreads: number;
    maxUserThreads: number;
    maxTurnsStored: number;
    promptTurns: number;
}

export type PlanTier = 'pro' | 'premium' | 'free';

/**
 * Thread limits per plan tier.
 *
 * promptTurns is the token-cost driver (turns actually injected into the LLM
 * prompt). Each user or assistant message counts as one turn. The rest are Redis storage bounds
 * and mainly affect how long threads survive before eviction.
 */
export function getThreadLimitsForTier(planTier: PlanTier): ThreadLimits {
    if (planTier === 'pro') {
        return {
            maxChannelThreads: 250,
            maxUserThreads: 12,
            maxTurnsStored: 120,
            promptTurns: 100
        };
    }
    if (planTier === 'premium') {
        return {
            maxChannelThreads: 100,
            maxUserThreads: 6,
            maxTurnsStored: 60,
            promptTurns: 40
        };
    }
    return {
        maxChannelThreads: 40,
        maxUserThreads: 3,
        maxTurnsStored: 20,
        promptTurns: 10
    };
}
