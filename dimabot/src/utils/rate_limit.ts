import { createHash } from 'node:crypto';
import { getDragonflyClient } from './databases/dragonfly.database.js';

export interface RateLimitResult {
    allowed: boolean;
    count: number;
    /** Seconds until the window resets. */
    retryAfter: number;
}

/**
 * Fixed-window counter in Dragonfly. The key is hashed, so raw IPs aren't stored.
 * Usage: `await hitRateLimit('docs-assistant:minute', ip, 8, 60)`.
 */
export async function hitRateLimit(scope: string, subject: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const key = `ratelimit:${scope}:${createHash('sha256').update(subject).digest('base64url')}`;
    const redis = await getDragonflyClient('rate-limit');
    const [count, ttl] = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n, redis.call('TTL',KEYS[1])}",
        { keys: [key], arguments: [String(windowSeconds)] },
    ) as [number, number];
    return { allowed: Number(count) <= limit, count: Number(count), retryAfter: Math.max(1, Number(ttl)) };
}
