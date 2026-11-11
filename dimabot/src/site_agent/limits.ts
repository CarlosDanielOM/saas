/**
 * Daily message limit per channel (owner + admins share it), per UTC day, by the channel's plan.
 * One user message = 1 (new, steer or queued), however many tool calls it makes.
 */
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { PLAN_MODELS, SITE_AGENT_KEYS } from './config.js';
import type { LimitsView, PlanTier } from './types.js';

export const utcDay = (at = new Date()): string => at.toISOString().slice(0, 10);

export function nextUtcMidnight(at = new Date()): number {
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
}

const TAKE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return {0, used} end
used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return {1, used}`;

export async function readLimits(channelId: string, plan: PlanTier): Promise<LimitsView> {
    const redis = await getDragonflyClient('site-agent-limits');
    const used = Number(await redis.get(SITE_AGENT_KEYS.dailyCount(channelId, utcDay())) ?? 0);
    return { plan, used, limit: PLAN_MODELS[plan].dailyMessages, resetsAt: nextUtcMidnight() };
}

/** Atomically takes one message. `allowed: false` when the channel is at its limit. */
export async function takeMessage(channelId: string, plan: PlanTier): Promise<{ allowed: boolean; limits: LimitsView }> {
    const redis = await getDragonflyClient('site-agent-limits');
    const limit = PLAN_MODELS[plan].dailyMessages;
    const [allowed, used] = await redis.eval(TAKE, {
        keys: [SITE_AGENT_KEYS.dailyCount(channelId, utcDay())],
        arguments: [String(limit), String(2 * 86_400)],
    }) as [number, number];
    return { allowed: Number(allowed) === 1, limits: { plan, used: Number(used), limit, resetsAt: nextUtcMidnight() } };
}

/** Gives a message back when it never reached the model because of our own failure. */
export async function refundMessage(channelId: string, day: string): Promise<void> {
    const redis = await getDragonflyClient('site-agent-limits');
    await redis.eval(`local v = tonumber(redis.call('GET', KEYS[1]) or '0') if v > 0 then return redis.call('DECR', KEYS[1]) end return 0`,
        { keys: [SITE_AGENT_KEYS.dailyCount(channelId, day)], arguments: [] });
}
