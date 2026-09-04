import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IStreamOfflineEvent } from "../interfaces/twitch/eventsub.interface.js";
import { error as logError, info as logInfo } from "../utils/logger.js";

interface StreamOfflineHandlerResponse {
    error: boolean;
    message: string;
}

export async function streamOfflineHandler(
    eventData: IStreamOfflineEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean
): Promise<StreamOfflineHandlerResponse> {
    try {
        const { broadcaster_user_id } = eventData;

        if (!chatEnabled) {
            await logInfo({
                message: 'Chat disabled - stream offline announcement skipped',
                channelID: broadcaster_user_id
            }, { channelId: broadcaster_user_id, destination: 'both' });

            return {
                error: false,
                message: 'Chat is disabled'
            };
        }

        if (eventsubData.message) {
            const context: SendMessageContext = {
                channelID: broadcaster_user_id,
                eventData: eventData
            };

            await sendTwitchChatMessage(broadcaster_user_id, eventsubData.message, null, context);
        }

        await logInfo({
            message: 'Stream offline announcement handled',
            channelID: broadcaster_user_id
        }, { channelId: broadcaster_user_id, destination: 'both' });

        return {
            error: false,
            message: 'Stream offline handled'
        };
    } catch (err) {
        await logError({
            function: 'streamOfflineHandler',
            eventData,
            eventsubData,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: eventData.broadcaster_user_id, destination: 'both' });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
