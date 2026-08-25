export interface ThreadLimits {
    maxChannelThreads: number;
    maxUserThreads: number;
    maxTurnsStored: number;
    promptTurns: number;
}

export type PlanTier = 'pro' | 'premium' | 'free';

export function getThreadLimitsForTier(planTier: PlanTier): ThreadLimits {
    if (planTier === 'pro') {
        return {
            maxChannelThreads: 360,
            maxUserThreads: 27,
            maxTurnsStored: 180,
            promptTurns: 54
        };
    }
    if (planTier === 'premium') {
        return {
            maxChannelThreads: 120,
            maxUserThreads: 9,
            maxTurnsStored: 60,
            promptTurns: 18
        };
    }
    return {
        maxChannelThreads: 40,
        maxUserThreads: 3,
        maxTurnsStored: 20,
        promptTurns: 6
    };
}
