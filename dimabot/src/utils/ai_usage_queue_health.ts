import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { warn } from './logger.js';
export const USAGE_QUEUES = [
    { name: 'receipts', queue: 'cron:ai-usage-receipts:queue', processing: 'cron:ai-usage-receipts:processing', dead: 'cron:ai-usage-receipts:queue:dead' },
    { name: 'backfills', queue: 'cron:ai-usage-backfills:queue', processing: 'cron:ai-usage-backfills:processing', dead: 'cron:ai-usage-backfills:dead' }
] as const;
type UsageQueue = typeof USAGE_QUEUES[number];
const claimScript = `
local item = redis.call('LPOP', KEYS[1])
if item then
 redis.call('RPUSH', KEYS[2], item)
 redis.call('HSET', KEYS[3], 'processingSince', ARGV[1])
end
return item`;
export async function claimUsageJob(cache: RedisClientType, queue: UsageQueue) {
    const value = await cache.eval(claimScript, { keys: [queue.queue, queue.processing, `ai-usage:queue-health:${queue.name}`], arguments: [String(Date.now())] });
    return typeof value === 'string' ? value : null;
}
export async function completeUsageJob(cache: RedisClientType, queue: UsageQueue, raw: string) {
    const retryKey = `${queue.queue}:attempts:${createHash('sha256').update(raw).digest('hex')}`;
    await cache.eval(`redis.call('LREM', KEYS[1], 1, ARGV[1]); redis.call('DEL', KEYS[2]); return 1`, {
        keys: [queue.processing, retryKey], arguments: [raw]
    });
}
export async function failUsageJob(cache: RedisClientType, queue: UsageQueue, raw: string, invalid = false, maxAttempts = 3) {
    const retryKey = `${queue.queue}:attempts:${createHash('sha256').update(raw).digest('hex')}`;
    return Number(await cache.eval(`
local attempts = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], 604800)
redis.call('HINCRBY', KEYS[5], 'failures', 1)
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return 0 end
if attempts >= tonumber(ARGV[2]) then
 redis.call('RPUSH', KEYS[3], ARGV[1]); redis.call('DEL', KEYS[4]); return 2
end
redis.call('RPUSH', KEYS[2], ARGV[1]); return 1`, {
        keys: [queue.processing, queue.queue, queue.dead, retryKey, `ai-usage:queue-health:${queue.name}`],
        arguments: [raw, String(invalid ? 1 : maxAttempts)]
    }));
}
export async function monitorAiUsageQueues(cache: RedisClientType, now = Date.now()) {
    const statuses = [];
    for (const queue of USAGE_QUEUES) {
        const key = `ai-usage:queue-health:${queue.name}`;
        const [pending, processing, dead, oldest, previous] = await Promise.all([
            cache.lLen(queue.queue), cache.lLen(queue.processing), cache.lLen(queue.dead),
            cache.lIndex(queue.queue, 0), cache.hGetAll(key)
        ]);
        let queuedAt = 0;
        try { const parsed = JSON.parse(oldest || '{}'); queuedAt = new Date(parsed.enqueuedAt || parsed.requestedAt || '').getTime() || 0; } catch { /* reported as invalid when consumed */ }
        const pendingSince = pending ? Number(previous.pendingSince) || now : 0;
        const oldestAgeSeconds = pending ? Math.max(0, (now - (queuedAt || pendingSince)) / 1000) : 0;
        const processingAgeSeconds = processing ? Math.max(0, (now - (Number(previous.processingSince) || now)) / 1000) : 0;
        const failures = Number(previous.failures || 0);
        const reasons = [];
        if (oldestAgeSeconds > Number(process.env.AI_USAGE_QUEUE_MAX_AGE_SECONDS || 900)) reasons.push('queue_age');
        if (processingAgeSeconds > Number(process.env.AI_USAGE_PROCESSING_MAX_AGE_SECONDS || 900)) reasons.push('processing_stalled');
        if (dead) reasons.push('dead_letters');
        if (failures - Number(previous.observedFailures || 0) >= Number(process.env.AI_USAGE_QUEUE_FAILURE_THRESHOLD || 3)) reasons.push('repeated_failures');
        const status = { queue: queue.name, pending, processing, dead, oldestAgeSeconds, processingAgeSeconds, failures, reasons, checkedAt: new Date(now).toISOString() };
        await cache.set(`ai-usage:queue-health:${queue.name}:snapshot`, JSON.stringify(status), { EX: 300 });
        await cache.hSet(key, { pendingSince: String(pendingSince), observedFailures: String(failures) });
        if (reasons.length && await cache.set(`${key}:alert`, '1', { NX: true, EX: 300 }) === 'OK') {
            await warn({ worker: 'ai_usage_receipts', message: 'AI usage queue requires attention', ...status }, { destination: 'both' });
        }
        statuses.push(status);
    }
    return statuses;
}
