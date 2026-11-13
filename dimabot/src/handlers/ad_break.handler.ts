import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IAdBreakEvent } from "../interfaces/twitch/eventsub.interface.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import { chatSendDecision, recordAlert, type AlertDecision } from "../utils/activity_events.js";

interface AdBreakHandlerResponse {
    error: boolean;
    message: string;
}

export async function adBreakHandler(
    eventData: IAdBreakEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean,
    /** Twitch message id, for the activity rows. */
    messageId?: string
): Promise<AdBreakHandlerResponse> {
    // Start and end messages are two alerts of one event; `part` keeps their rows apart.
    const noteAlert = (decision: AlertDecision, part?: 'end') => recordAlert({ type: 'channel.ad_break.begin',
        channelID: eventData?.broadcaster_user_id, payload: eventData, ref: messageId, part }, decision);
    try {
        const { broadcaster_user_id, duration_seconds } = eventData;

        if (!chatEnabled) {
            noteAlert({ outcome: 'skipped', reason: 'chat_disabled' });
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

            const sent = await sendTwitchChatMessage(broadcaster_user_id, eventsubData.message, null, context, { origin: 'alert' });
            noteAlert(chatSendDecision(sent));
        } else {
            noteAlert({ outcome: 'skipped', reason: 'empty_message' });
        }

        if (eventsubData.endEnabled) {
            setTimeout(async () => {
                if (eventsubData.endMessage) {
                    const context: SendMessageContext = {
                        channelID: broadcaster_user_id,
                        eventData: eventData
                    };

                    const sent = await sendTwitchChatMessage(broadcaster_user_id, eventsubData.endMessage, null, context, { origin: 'alert' });
                    noteAlert(chatSendDecision(sent), 'end');
                } else {
                    noteAlert({ outcome: 'skipped', reason: 'empty_message' }, 'end');
                }
            }, duration_seconds * 1000);
        }

        await logInfo({
            message: 'Ad break started',
            channelID: broadcaster_user_id,
            duration: duration_seconds,
            endEnabled: eventsubData.endEnabled
        }, { channelId: broadcaster_user_id, destination: 'both' });

        return {
            error: false,
            message: 'Ad break handled'
        };
    } catch (err) {
        noteAlert({ outcome: 'failed', reason: 'handler_error', error: err });
        await logError({
            function: 'adBreakHandler',
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
