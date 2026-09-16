import { getTwitchBotHeader, TWITCH_BOT_ACCOUNT_ID } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { error as logError } from '../../utils/logger.js';

export interface WarnResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
}

/**
 * Sends an official Twitch warning to a user (Warn User Helix endpoint).
 * Executed by the bot account per the bot-executed moderation policy —
 * moderator_id must match the bot token owner.
 */
export async function warnUser(channelID: string, userID: string, reason: string): Promise<WarnResponse> {
    try {
        const botHeaderResult = await getTwitchBotHeader();

        if (botHeaderResult.error || !botHeaderResult.header) {
            return {
                error: true,
                message: botHeaderResult.message,
                status: 403,
                type: 'permission_error'
            };
        }

        const params = new URLSearchParams({
            broadcaster_id: channelID,
            moderator_id: TWITCH_BOT_ACCOUNT_ID
        });

        const response = await fetch(getTwitchHelixUrl('moderation/warnings', params.toString()), {
            method: 'POST',
            headers: botHeaderResult.header as unknown as Record<string, string>,
            body: JSON.stringify({
                data: {
                    user_id: userID,
                    reason: reason.slice(0, 500)
                }
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || data.error) {
            return {
                error: true,
                message: data.message || response.statusText || 'Twitch warn request failed',
                status: response.status,
                type: data.error
            };
        }

        return {
            error: false,
            message: 'Warning issued',
            status: response.status
        };
    } catch (err) {
        await logError({
            function: 'warnUser',
            channelID,
            userID,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}
