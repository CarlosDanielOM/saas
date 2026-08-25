/**
 * AI Stream Context
 *
 * Provides the channel's live stream state (title, game, uptime, viewers) so
 * the AI harness can react to what is happening on stream.
 *
 * Reads from the site's cached live-channels board (siteanalytics), the same
 * data source as the streamer dashboard live stats - zero extra Twitch API
 * requests.
 */

import { getCachedLiveStatus } from '../siteanalytics.js';
import { error as logError } from '../logger.js';

export interface AIStreamContext {
    isLive: boolean;
    title?: string;
    gameName?: string;
    startedAt?: string;
    uptimeMinutes?: number;
    viewerCount?: number;
}

export async function getAIStreamContext(channelID: string): Promise<AIStreamContext | null> {
    if (!channelID) return null;

    try {
        const live = await getCachedLiveStatus(channelID);
        if (!live.isLive || !live.stream) {
            return { isLive: false };
        }

        const startedAt = live.stream.started_at ? new Date(live.stream.started_at) : null;
        return {
            isLive: true,
            title: live.stream.title,
            gameName: live.stream.game_name,
            startedAt: startedAt ? startedAt.toISOString() : undefined,
            uptimeMinutes: startedAt && !Number.isNaN(startedAt.getTime())
                ? Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60000))
                : undefined,
            viewerCount: Number.isFinite(Number(live.stream.viewer_count))
                ? Number(live.stream.viewer_count)
                : undefined
        };
    } catch (err) {
        await logError({
            function: 'getAIStreamContext',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        }, { channelId: channelID, destination: 'cache' });
        return null;
    }
}
