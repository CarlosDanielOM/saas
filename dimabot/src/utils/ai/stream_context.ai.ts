/**
 * AI Stream Context
 *
 * Provides a cached snapshot of the channel's live stream state (title, game,
 * uptime, viewers) so the AI harness can react to what is happening on stream.
 * Cached in Redis to avoid hitting the Twitch API on every AI mention:
 * at most 1 Helix request per channel per CACHE_TTL_SECONDS.
 */

import { isLive } from '../../functions/channels/is_live.channel.js';
import { getDragonflyClient } from '../databases/dragonfly.database.js';
import { error as logError } from '../logger.js';

const CACHE_TTL_LIVE_SECONDS = 120;
const CACHE_TTL_OFFLINE_SECONDS = 300;

export interface AIStreamContext {
    isLive: boolean;
    title?: string;
    gameName?: string;
    startedAt?: string;
    uptimeMinutes?: number;
    viewerCount?: number;
}

function cacheKey(channelID: string): string {
    return `twitch:${channelID}:ai:stream_context`;
}

export async function getAIStreamContext(channelID: string): Promise<AIStreamContext | null> {
    if (!channelID) return null;

    try {
        const cache = await getDragonflyClient('AIStreamContext');
        const cached = await cache.get(cacheKey(channelID));
        if (cached) {
            return JSON.parse(cached) as AIStreamContext;
        }

        const liveResult = await isLive(channelID);
        if (liveResult.error || !Array.isArray(liveResult.data)) {
            return null;
        }

        const stream = liveResult.data[0];
        let context: AIStreamContext;
        let ttl = CACHE_TTL_OFFLINE_SECONDS;

        if (stream) {
            const startedAt = stream.started_at ? new Date(stream.started_at) : null;
            context = {
                isLive: true,
                title: typeof stream.title === 'string' ? stream.title : undefined,
                gameName: typeof stream.game_name === 'string' ? stream.game_name : undefined,
                startedAt: startedAt ? startedAt.toISOString() : undefined,
                uptimeMinutes: startedAt
                    ? Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60000))
                    : undefined,
                viewerCount: Number.isFinite(Number(stream.viewer_count))
                    ? Number(stream.viewer_count)
                    : undefined
            };
            ttl = CACHE_TTL_LIVE_SECONDS;
        } else {
            context = { isLive: false };
        }

        await cache.set(cacheKey(channelID), JSON.stringify(context), { EX: ttl });
        return context;
    } catch (err) {
        await logError({
            function: 'getAIStreamContext',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'cache' });
        return null;
    }
}
