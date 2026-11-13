/**
 * Daily message limit per channel (owner + admins share it), per UTC day, by the channel's plan.
 * One user message (new, steer or queued) uses its level's cost (Standard 1, Expert 2), however many tool
 * calls it makes.
 */
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { SITE_AGENT_KEYS, SITE_AGENT_PLANS } from './config.js';
import type { LimitsView, PlanTier } from './types.js';

export const utcDay = (at = new Date()): string => at.toISOString().slice(0, 10);

export function nextUtcMidnight(at = new Date()): number {
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
}

const TAKE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[3])
if used + cost > tonumber(ARGV[1]) then return {0, used} end
used = redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return {1, used}`;

export async function readLimits(channelId: string, plan: PlanTier): Promise<LimitsView> {
    const redis = await getDragonflyClient('site-agent-limits');
    const used = Number(await redis.get(SITE_AGENT_KEYS.dailyCount(channelId, utcDay())) ?? 0);
    return { plan, used, limit: SITE_AGENT_PLANS[plan].dailyMessages, resetsAt: nextUtcMidnight() };
}

/** Atomically takes `cost` messages. `allowed: false` when fewer than that are left today. */
export async function takeMessage(channelId: string, plan: PlanTier, cost = 1): Promise<{ allowed: boolean; limits: LimitsView }> {
    const redis = await getDragonflyClient('site-agent-limits');
    const limit = SITE_AGENT_PLANS[plan].dailyMessages;
    const [allowed, used] = await redis.eval(TAKE, {
        keys: [SITE_AGENT_KEYS.dailyCount(channelId, utcDay())],
        arguments: [String(limit), String(2 * 86_400), String(Math.max(1, Math.floor(cost)))],
    }) as [number, number];
    return { allowed: Number(allowed) === 1, limits: { plan, used: Number(used), limit, resetsAt: nextUtcMidnight() } };
}

const ADD = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = math.max(0, math.min(tonumber(ARGV[3]), tonumber(ARGV[1]) - used))
if n > 0 then used = redis.call('INCRBY', KEYS[1], n) redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {n, used}`;

/**
 * Charges `units` more for a turn already running (e.g. an Expert fallback). Never refuses and never goes past the
 * limit: charges what is left. Returns what it charged.
 */
export async function chargeMore(channelId: string, plan: PlanTier, units: number): Promise<{ charged: number; day: string; limits: LimitsView }> {
    const redis = await getDragonflyClient('site-agent-limits');
    const limit = SITE_AGENT_PLANS[plan].dailyMessages;
    const day = utcDay();
    const [charged, used] = await redis.eval(ADD, {
        keys: [SITE_AGENT_KEYS.dailyCount(channelId, day)],
        arguments: [String(limit), String(2 * 86_400), String(Math.max(0, Math.floor(units)))],
    }) as [number, number];
    return { charged: Number(charged), day, limits: { plan, used: Number(used), limit, resetsAt: nextUtcMidnight() } };
}

/** Gives `cost` messages back when the message never reached the model because of our own failure. */
export async function refundMessage(channelId: string, day: string, cost = 1): Promise<void> {
    const redis = await getDragonflyClient('site-agent-limits');
    await redis.eval(`local v = tonumber(redis.call('GET', KEYS[1]) or '0') local n = math.min(v, tonumber(ARGV[1])) if n > 0 then return redis.call('DECRBY', KEYS[1], n) end return 0`,
        { keys: [SITE_AGENT_KEYS.dailyCount(channelId, day)], arguments: [String(Math.max(1, Math.floor(cost)))] });
}
