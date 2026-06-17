import { error as logError, warn as logWarn } from "../../utils/logger.js";
import { getTwitchHelixUrl } from "../../utils/links.js";
import { getAppToken } from "../../utils/tokens.js";
import { parseSpecialCommands } from "../../handlers/special_parser.handler.js";
import type { ITwitchEventData } from "../../interfaces/twitch/eventsub.interface.js";
import type { IEventsub } from "../../schemas/eventsub.schema.js";

const MODERATOR_ID = '698614112';

export interface SendMessageContext {
    channelID: string;
    eventData?: ITwitchEventData | any;
    eventsubData?: IEventsub | any;
    argument?: string;
    variables?: Record<string, string>;
    userPlan?: 'free' | 'premium' | 'pro';
    userLevel?: number;
    extraContext?: Record<string, unknown>;
}

export const sendTwitchChatMessage = async (
    channelID: string,
    message: string,
    replyToMessageId: string | null = null,
    context?: SendMessageContext
) => {
    try {
        const twitchAppToken = await getAppToken('twitch');

        if(!twitchAppToken) {
            await logError({
                function: 'sendTwitchChatMessage.getAppToken',
                channelID,
                sender_id: MODERATOR_ID,
                messagePreview: message?.slice(0, 120),
                error: 'Failed to get Twitch app token',
                timestamp: new Date().toISOString(),
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: 'Failed to get Twitch app token',
                status: 500,
                type: 'error',
                reason: 'Failed to get Twitch app token',
            }
        }

        let finalMessage = message;

        if (context) {
            try {
                const parsedResult = await parseSpecialCommands(message, context);
                finalMessage = parsedResult.parsedText;
            } catch (parseError) {
                await logWarn({
                    function: 'sendTwitchChatMessage.parseSpecialCommands',
                    channelID,
                    error: parseError instanceof Error ? parseError.message : String(parseError)
                }, { channelId: channelID, destination: 'both' });
            }
        }

        let body = {
            broadcaster_id: channelID,
            sender_id: MODERATOR_ID,
            message: finalMessage,
        }

        if(replyToMessageId) {
            (body as any).reply_parent_message_id = replyToMessageId;
        }

        const response = await fetch(getTwitchHelixUrl('chat/messages'), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${twitchAppToken}`,
                'Client-Id': process.env.CLIENT_ID!,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const data = await response.json();

        if(response.status < 200 || response.status > 299) {
            await logError({
                function: 'sendTwitchChatMessage.twitchRejected',
                channelID,
                sender_id: MODERATOR_ID,
                messagePreview: finalMessage?.slice(0, 120),
                httpStatus: response.status,
                twitchError: data?.error,
                twitchMessage: data?.message,
                tokenSource: 'appToken',
                timestamp: new Date().toISOString(),
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: data.message,
                status: response.status,
                type: data.error,
            }
        }

        const isSent = data?.data?.[0]?.is_sent;
        const messageId = data?.data?.[0]?.message_id;

        if (isSent === false) {
            await logError({
                function: 'sendTwitchChatMessage.heldForModeration',
                channelID,
                sender_id: MODERATOR_ID,
                messagePreview: finalMessage?.slice(0, 120),
                httpStatus: response.status,
                twitchMessageId: messageId,
                twitchIsSent: isSent,
                reason: 'Twitch held the message for moderator review (is_sent=false). Bot account may be unverified, new, or triggering AutoMod holds in this channel.',
                tokenSource: 'appToken',
                timestamp: new Date().toISOString(),
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: 'Message held for moderation review by Twitch',
                status: response.status,
                type: 'held_for_moderation',
                reason: 'Twitch held the message for moderator review (is_sent=false). Bot account may be unverified, new, or triggering AutoMod holds in this channel.',
                data: data.data[0],
            }
        }

        return {
            error: false,
            message: 'Message sent',
            status: response.status,
            type: 'success',
            data: data.data[0],
        }

    } catch (err) {
        await logError({
            function: 'sendTwitchChatMessage',
            channelID,
            sender_id: MODERATOR_ID,
            messagePreview: message?.slice(0, 120),
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            timestamp: new Date().toISOString(),
        }, { channelId: channelID, destination: 'both' });

        return {
            error: true,
            message: 'Error sending Twitch chat message',
            status: 500,
            type: 'error',
            reason: err instanceof Error ? err.message : String(err),
        }
    }
}
