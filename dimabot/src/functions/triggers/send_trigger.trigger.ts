import TwitchStreamers from "../../classes/twitch_streamers.class.js";
import { getApiUrl } from "../../utils/dev.js";
import { error as logError } from "../../utils/logger.js";

interface TriggerData {
    url: string;
    mediaType: string;
    volume: number;
}

interface SendTriggerResponse {
    error: boolean;
    message: string;
}

export async function sendTrigger(
    channelID: string,
    triggerData: TriggerData,
    queue: boolean = false
): Promise<SendTriggerResponse> {
    try {
        const streamerToken = await TwitchStreamers.getAccountTokenById(channelID, 'twitch');

        if (!streamerToken) {
            // A wiped/never-granted token set (has_permissions=false) means the
            // streamer must reauthorize; anything else is a transient refresh
            // failure that can succeed on a later attempt.
            const account = await TwitchStreamers.getTwitchAccountById(channelID);
            const permissionsRevoked = !account || account.has_permissions !== 'true';

            await logError({
                function: 'sendTrigger',
                channelID,
                error: 'Failed to get streamer token',
                hasPermissions: account?.has_permissions ?? null
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: permissionsRevoked
                    ? "I don't have the permissions to perform this action. Please reauthenticate in the dashboard."
                    : 'Failed to renew permissions. Please try again later.'
            };
        }

        const body = {
            ...triggerData,
            queue
        };

        const response = await fetch(`${getApiUrl()}/triggers/${channelID}/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${streamerToken}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const responseData = await response.json();
            await logError({
                function: 'sendTrigger',
                channelID,
                triggerData,
                queue,
                response: responseData,
                status: response.status
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: responseData.message || 'Error sending trigger'
            };
        }

        return {
            error: false,
            message: 'Trigger sent'
        };
    } catch (err) {
        await logError({
            function: 'sendTrigger',
            channelID,
            triggerData,
            queue,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
