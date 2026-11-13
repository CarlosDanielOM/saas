import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IBanEvent } from "../interfaces/twitch/eventsub.interface.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import { chatSendDecision, recordAlert, type AlertDecision } from "../utils/activity_events.js";

interface BanHandlerResponse {
    error: boolean;
    message: string;
}

export async function banHandler(
    eventData: IBanEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean,
    /** Twitch message id, for the activity row. */
    messageId?: string
): Promise<BanHandlerResponse> {
    const noteAlert = (decision: AlertDecision) => recordAlert({ type: 'channel.ban', channelID: eventData?.broadcaster_user_id,
        payload: eventData, ref: messageId, data: { permanent: eventData?.is_permanent === true } }, decision);
    try {
        const { broadcaster_user_id, is_permanent } = eventData;

        if (!chatEnabled) {
            noteAlert({ outcome: 'skipped', reason: 'chat_disabled' });
            return {
                error: false,
                message: 'Chat is disabled'
            };
        }

        let messageToSend: string;

        if (is_permanent) {
            messageToSend = eventsubData.message;
        } else {
            messageToSend = eventsubData.temporalBanMessage || '';
        }

        if (!messageToSend || messageToSend.trim() === '') {
            noteAlert({ outcome: 'skipped', reason: 'empty_message' });
            return {
                error: false,
                message: 'No message to send'
            };
        }

        const context: SendMessageContext = {
            channelID: broadcaster_user_id,
            eventData: eventData
        };

        const sent = await sendTwitchChatMessage(broadcaster_user_id, messageToSend, null, context, { origin: 'alert' });
        noteAlert(chatSendDecision(sent));

        await logInfo({
            message: 'Ban handled',
            channelID: broadcaster_user_id,
            isPermanent: is_permanent
        }, { channelId: broadcaster_user_id, destination: 'both' });

        return {
            error: false,
            message: 'Ban handled'
        };
    } catch (err) {
        noteAlert({ outcome: 'failed', reason: 'handler_error', error: err });
        await logError({
            function: 'banHandler',
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
