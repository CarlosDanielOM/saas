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
 * prompt) and scales ~2-2.5x per tier. The rest are cheap Redis storage bounds
 * and mainly affect how long threads survive before eviction.
 */
export function getThreadLimitsForTier(planTier: PlanTier): ThreadLimits {
    if (planTier === 'pro') {
        return {
            maxChannelThreads: 250,
            maxUserThreads: 12,
            maxTurnsStored: 60,
            promptTurns: 20
        };
    }
    if (planTier === 'premium') {
        return {
            maxChannelThreads: 100,
            maxUserThreads: 6,
            maxTurnsStored: 40,
            promptTurns: 10
        };
    }
    return {
        maxChannelThreads: 40,
        maxUserThreads: 3,
        maxTurnsStored: 20,
        promptTurns: 4
    };
}
