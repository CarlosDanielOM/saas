/** Command cooldowns belong to the channel owner's plan, not the chatter's. */
export function getMinimumCommandCooldown(planTier: unknown): number {
    if (planTier === 'pro') return 1;
    if (planTier === 'premium') return 3;
    return 5;
}
