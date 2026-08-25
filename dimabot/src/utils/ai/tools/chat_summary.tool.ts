/**
 * Chat Summary Tool
 *
 * Returns the most recent chat messages so the AI can summarize what has been
 * happening in chat (e.g. a mod asking "what did I miss?" or "how is chat
 * today"). Read-only; message count is capped by plan tier to bound tokens.
 */

import ChatHistory from '../../../classes/chat_history.js';
import type { IStreamerData } from './code_execution.tool.js';

export interface ChatSummaryToolResult {
    success: boolean;
    result?: {
        messageCount: number;
        messages: Array<{ username: string; message: string; timestamp: number }>;
    };
    error?: string;
}

export interface ChatSummaryToolContext {
    channelID: string;
    streamer: IStreamerData;
}

export interface ChatSummaryArgs {
    /** How many recent messages to include. Capped by plan tier. */
    count?: number;
}

function getMaxMessagesForTier(planTier: string | undefined): number {
    if (planTier === 'pro') return 50;
    if (planTier === 'premium') return 30;
    return 20;
}

export async function execute(
    args: ChatSummaryArgs,
    context: ChatSummaryToolContext
): Promise<ChatSummaryToolResult> {
    const channelID = context.channelID;
    if (!channelID) {
        return { success: false, error: 'Channel ID is missing from context' };
    }

    const maxMessages = getMaxMessagesForTier(context.streamer?.plan_tier);
    const requested = Number(args?.count) || maxMessages;
    const limit = Math.max(1, Math.min(requested, maxMessages));

    try {
        const messages = await ChatHistory.getRecentMessages(channelID, limit);
        const items = (Array.isArray(messages) ? messages : []).map((msg: any) => ({
            username: String(msg?.username || 'unknown'),
            message: String(msg?.message || ''),
            timestamp: Number(msg?.timestamp || 0)
        })).filter((msg) => msg.message.length > 0);

        return {
            success: true,
            result: {
                messageCount: items.length,
                messages: items
            }
        };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
