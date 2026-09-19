import type { RedisClientType } from 'redis';
import { randomUUID } from 'node:crypto';

import { getAiUsageRetentionDays } from './ai_usage_ledger.js';

export const AI_USAGE_BACKFILL_QUEUE_KEY = 'cron:ai-usage-backfills:queue';
export const AI_USAGE_BACKFILL_PROCESSING_KEY = 'cron:ai-usage-backfills:processing';
export const AI_USAGE_BACKFILL_DEAD_KEY = 'cron:ai-usage-backfills:dead';

const DEDUPE_PREFIX = 'cron:ai-usage-backfills:dedupe';
const DEDUPE_SECONDS = Math.max(300, Number(process.env.AI_USAGE_BACKFILL_DEDUPE_SECONDS || 172_800));
const ENQUEUE_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  redis.call('RPUSH', KEYS[2], ARGV[3])
  return 1
end
return 0
`;

export type AiUsageBackfillTier = 'free' | 'premium' | 'pro';

export interface AiUsageBackfillJob {
    id: string;
    channelID: string;
    customerId: string;
    planTier: AiUsageBackfillTier;
    coverageStart: string;
    requestedAt: string;
    reason: 'api_request' | 'daily_sweep' | 'startup_sweep';
    attempts: number;
    dedupeKey: string;
}

function normalizeTier(value: unknown): AiUsageBackfillTier {
    return value === 'pro' ? 'pro' : value === 'premium' ? 'premium' : 'free';
}

function safePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function getAiUsageDesiredCoverageStart(planTier: unknown, now = new Date()): Date {
    const retentionDays = getAiUsageRetentionDays(planTier);
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (retentionDays - 1));
    return start;
}

export function parseAiUsageBackfillJob(raw: string): AiUsageBackfillJob | null {
    try {
        const parsed = JSON.parse(raw) as Partial<AiUsageBackfillJob>;
        const coverageStart = new Date(String(parsed.coverageStart || ''));
        const requestedAt = new Date(String(parsed.requestedAt || ''));
        if (!safePart(parsed.id) || !safePart(parsed.channelID) || !safePart(parsed.customerId)
            || !safePart(parsed.dedupeKey) || Number.isNaN(coverageStart.getTime())
            || Number.isNaN(requestedAt.getTime())) return null;
        return {
            id: safePart(parsed.id),
            channelID: safePart(parsed.channelID),
            customerId: safePart(parsed.customerId),
            planTier: normalizeTier(parsed.planTier),
            coverageStart: coverageStart.toISOString(),
            requestedAt: requestedAt.toISOString(),
            reason: parsed.reason === 'daily_sweep' || parsed.reason === 'startup_sweep'
                ? parsed.reason : 'api_request',
            attempts: Math.max(0, Number.isInteger(parsed.attempts) ? Number(parsed.attempts) : 0),
            dedupeKey: safePart(parsed.dedupeKey)
        };
    } catch {
        return null;
    }
}

export async function enqueueAiUsageBackfill(
    cache: RedisClientType,
    input: {
        channelID: string;
        customerId: string;
        planTier: unknown;
        coverageStart?: Date;
        reason?: AiUsageBackfillJob['reason'];
        now?: Date;
    }
): Promise<{ enqueued: boolean; job: AiUsageBackfillJob }> {
    const now = input.now || new Date();
    const channelID = safePart(input.channelID);
    const customerId = safePart(input.customerId);
    if (!channelID || !customerId) throw new Error('AI usage backfill requires channel and customer IDs');
    const planTier = normalizeTier(input.planTier);
    const coverageStart = input.coverageStart || getAiUsageDesiredCoverageStart(planTier, now);
    const dedupeKey = `${DEDUPE_PREFIX}:${channelID}:${customerId}`;
    const job: AiUsageBackfillJob = {
        id: randomUUID(),
        channelID,
        customerId,
        planTier,
        coverageStart: coverageStart.toISOString(),
        requestedAt: now.toISOString(),
        reason: input.reason || 'api_request',
        attempts: 0,
        dedupeKey
    };
    const enqueued = Number(await cache.eval(ENQUEUE_SCRIPT, {
        keys: [dedupeKey, AI_USAGE_BACKFILL_QUEUE_KEY],
        arguments: [job.id, String(DEDUPE_SECONDS), JSON.stringify(job)]
    })) === 1;
    return { enqueued, job };
}
