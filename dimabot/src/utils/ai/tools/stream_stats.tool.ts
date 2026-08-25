/**
 * Stream Stats Tool
 *
 * Returns live session metrics (uptime, viewers, follows, subs, bits, chat
 * messages, commands) so the AI can answer mod/streamer questions like
 * "how is the stream going today?". Read-only.
 */

import { getLiveSessionMetrics } from '../../stream_analytics.js';
import { getCachedLiveStatus } from '../../siteanalytics.js';
import type { IStreamerData } from './code_execution.tool.js';

export interface StreamStatsToolResult {
    success: boolean;
    result?: unknown;
    error?: string;
}

export interface StreamStatsToolContext {
    channelID: string;
    streamer: IStreamerData;
}

export async function execute(
    _args: Record<string, never>,
    context: StreamStatsToolContext
): Promise<StreamStatsToolResult> {
    const channelID = context.channelID;
    if (!channelID) {
        return { success: false, error: 'Channel ID is missing from context' };
    }

    try {
        // Same pipeline as the streamer dashboard live stats: session metrics
        // enriched with the current viewer count from the cached live board.
        const liveStatus = await getCachedLiveStatus(channelID);
        const metrics = await getLiveSessionMetrics(channelID, {
            currentViewers: liveStatus.isLive ? Number(liveStatus.stream?.viewer_count || 0) : null
        });
        if (!metrics) {
            return {
                success: true,
                result: { isLive: false, note: 'The stream is currently offline or no session data is available.' }
            };
        }
        return { success: true, result: metrics };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
