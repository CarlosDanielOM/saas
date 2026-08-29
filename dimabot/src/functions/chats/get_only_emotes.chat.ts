import { getTwitchModeratorHeader, TWITCH_BOT_ACCOUNT_ID } from '../../utils/header.js';
import { error as logError } from "../../utils/logger.js";
import { getTwitchHelixUrl } from '../../utils/links.js';

interface GetOnlyEmotesResponse {
    error: boolean;
    message: string;
    status?: number;
    type?: string;
    data?: boolean;
}

export async function getOnlyEmotes(
    channelID: string,
    modID: string = TWITCH_BOT_ACCOUNT_ID
): Promise<GetOnlyEmotesResponse> {
    try {
        const streamerHeaderResult = await getTwitchModeratorHeader(channelID, modID);

        if (streamerHeaderResult.error || !streamerHeaderResult.header) {
            return {
                error: true,
                message: streamerHeaderResult.message,
                status: 403
            };
        }

        const streamerHeader = streamerHeaderResult.header;

        let params = `?broadcaster_id=${channelID}`;

        params += `&moderator_id=${TWITCH_BOT_ACCOUNT_ID}`;

        const response = await fetch(`${getTwitchHelixUrl('chat/settings', params)}`, {
            headers: streamerHeader as unknown as Record<string, string>
        });

        const data = await response.json();
        const chatSettings = data.data[0];

        return {
            error: false,
            message: 'Success',
            status: 200,
            data: chatSettings.emote_mode
        };
    } catch (err) {
        await logError({ function: 'getOnlyEmotes',
            channelID,
            modID,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        });

        return {
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'error'
        };
    }
}
