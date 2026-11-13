import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IFollowEvent } from "../interfaces/twitch/eventsub.interface.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import { enqueueFollowDefenseFollow, shouldSuppressFollowAlerts } from "../utils/follow_defense_queue.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import { chatSendDecision, recordAlert, type AlertDecision } from "../utils/activity_events.js";

interface FollowHandlerResponse {
    error: boolean;
    message: string;
}

export async function followHandler(
    eventData: IFollowEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean,
    options: { durableDefenseHandled?: boolean; durableChatHandled?: boolean; messageId?: string } = {}
): Promise<FollowHandlerResponse> {
    // A journaled follow is announced by the chat-announcements consumer, which records its own alert row.
    const noteAlert = (decision: AlertDecision) => {
        if (!options.durableChatHandled) recordAlert({ type: 'channel.follow', channelID: eventData?.broadcaster_user_id, payload: eventData, ref: options.messageId }, decision);
    };
    try {
        const { broadcaster_user_id, user_name, user_login } = eventData;

        if (!options.durableDefenseHandled) void enqueueFollowDefenseFollow(eventData);

        if (!chatEnabled) {
            noteAlert({ outcome: 'skipped', reason: 'chat_disabled' });
            return {
                error: false,
                message: 'Chat is disabled'
            };
        }

        const cache = await getDragonflyClient('FollowHandler');
        const cacheKey = `${broadcaster_user_id}:follows:count`;
        let followCount = await cache.get(cacheKey) as string | null;

        if (!followCount) {
            followCount = '0';
        }

        const newCount = parseInt(followCount) + 1;
        await cache.set(cacheKey, newCount);

        let messageToSend = eventsubData.message || '';

        if (eventsubData.todayFollows) {
            messageToSend = `${eventsubData.message} (Follow #${newCount})`;
        }

        if (!messageToSend || messageToSend.trim() === '') {
            noteAlert({ outcome: 'skipped', reason: 'empty_message' });
            return {
                error: false,
                message: 'No message to send'
            };
        }

        const eventID = JSON.stringify(['legacy-follow', broadcaster_user_id, eventData.user_id, eventData.followed_at]);
        if (await shouldSuppressFollowAlerts(broadcaster_user_id, eventID)) {
            noteAlert({ outcome: 'skipped', reason: 'follow_defense' });
            return { error: false, message: 'Follow alert suppressed by defense mode' };
        }

        const context: SendMessageContext = {
            channelID: broadcaster_user_id,
            eventData: eventData,
            variables: {
                user: user_name,
                userLogin: user_login,
                count: String(newCount)
            }
        };

        const sent = await sendTwitchChatMessage(broadcaster_user_id, messageToSend, null, context, { origin: 'alert' });
        noteAlert(chatSendDecision(sent));

        await logInfo({
            message: 'Follow received',
            channelID: broadcaster_user_id,
            user: user_name,
            followCount: newCount,
            showCount: eventsubData.todayFollows
        }, { channelId: broadcaster_user_id, destination: 'both' });

        return {
            error: false,
            message: 'Follow handled'
        };
    } catch (err) {
        noteAlert({ outcome: 'failed', reason: 'handler_error', error: err });
        await logError({
            function: 'followHandler',
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
