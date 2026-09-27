import { getDragonflyClient } from '../databases/dragonfly.database.js';
import type { IModerationOffenseStep, IModerationRule } from '../../schemas/channel_moderation_settings.schema.js';

export function offenseKey(channelID: string, ruleID: string, userID: string): string {
    return `moderation:${channelID}:offenses:${ruleID}:${userID}`;
}

/**
 * Increments the per-user, per-rule offense counter and returns the new
 * count. The counter lives in Dragonfly with a fixed window: the first
 * offense starts the expiry, so a user who stops offending returns to a
 * clean slate after the window elapses.
 */
export async function recordOffense(channelID: string, ruleID: string, userID: string, windowSeconds: number, decisionID?: string): Promise<number> {
    const cache = await getDragonflyClient('moderation.recordOffense');
    const key = offenseKey(channelID, ruleID, userID);
    if (decisionID) {
        return Number(await cache.eval(`
            local previous = redis.call('GET', KEYS[2])
            if previous then return tonumber(previous) end
            local count = redis.call('INCR', KEYS[1])
            if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
            redis.call('SET', KEYS[2], count, 'EX', 86400)
            return count
        `, { keys: [key, `moderation:offense-receipt:${decisionID}`], arguments: [String(Math.max(60, Math.floor(windowSeconds)))] }));
    }
    const count = await cache.incr(key);
    if (count === 1) {
        await cache.expire(key, Math.max(60, Math.floor(windowSeconds)));
    }
    return count;
}

/**
 * Maps an offense count onto the rule's escalation ladder:
 * 1st offense → firstOffense, 2nd → secondOffense, 3rd and beyond → thirdOffense.
 */
export function resolveOffenseStep(rule: Pick<IModerationRule, 'firstOffense' | 'secondOffense' | 'thirdOffense'>, offenseNumber: number): IModerationOffenseStep {
    if (offenseNumber <= 1) return rule.firstOffense;
    if (offenseNumber === 2) return rule.secondOffense;
    return rule.thirdOffense;
}
