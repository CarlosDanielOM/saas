import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IBitUseEvent } from "../interfaces/twitch/eventsub.interface.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import { getBitsMessageText } from '../utils/bits_message.js';
import { bitsChatMessage, matchBitsRule, type BitsRule } from '../bits_rules/model.js';

interface CheerHandlerResponse {
    error: boolean;
    message: string;
}

export async function cheerHandler(
    eventData: IBitUseEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean,
    loadRules: (channelID: string, legacyTiers: unknown) => Promise<BitsRule[]> = async (channelID, legacyTiers) =>
        (await (await import('../bits_rules/store.js')).loadBitsRules(channelID, legacyTiers)).rules
): Promise<CheerHandlerResponse> {
    try {
        if (!eventData.broadcaster_user_id) {
            await logError({
                function: 'cheerHandler',
                error: 'Missing broadcaster_user_id in event data',
                eventData
            }, { channelId: 'unknown', destination: 'both' });

            return {
                error: true,
                message: 'Invalid event data'
            };
        }

        const channelID = eventData.broadcaster_user_id;

        if (!chatEnabled) {
            return {
                error: false,
                message: 'Chat is disabled'
            };
        }

        let messageToSend: string;

        if (eventData.is_anonymous) {
            await logInfo({
                message: 'Anonymous cheer received (Twitch disabled this, but keeping for future-proofing)',
                bits: eventData.bits,
                channelID
            }, { channelId: channelID, destination: 'both' });

            messageToSend = eventsubData.message || `Gracias por los ${eventData.bits} bits Anonimo!`;
        } else {
            const bits = eventData.bits;
            const rules = await loadRules(channelID, eventsubData.cheerTiers);
            const rule = matchBitsRule(rules, bits);
            await logInfo({
                message: rule ? 'Cheer matched Bits rule' : 'No Bits rule matched, using default message',
                rule: rule?.name || rule?.id,
                bits,
                channelID
            }, { channelId: channelID, destination: 'both' });
            messageToSend = bitsChatMessage(rules, eventsubData.message || '', bits);
        }

        if (!messageToSend || messageToSend.trim() === '') {
            return {
                error: false,
                message: 'No message to send'
            };
        }

        const context: SendMessageContext = {
            channelID: channelID,
            eventData: eventData,
            eventsubData: eventsubData,
            argument: getBitsMessageText(eventData.message),
            literalArguments: true,
            variables: {
                bits: String(eventData.bits),
                user: eventData.user_name ?? '',
                userLogin: eventData.user_login ?? ''
            }
        };

        const result = await sendTwitchChatMessage(channelID, messageToSend, null, context);

        if (result.error) {
            await logError({
                function: 'cheerHandler.sendTwitchChatMessage',
                channelID,
                bits: eventData.bits,
                error: result.message
            }, { channelId: channelID, destination: 'both' });

            return {
                error: true,
                message: result.message || 'Failed to send cheer message'
            };
        }

        return {
            error: false,
            message: 'Cheer handled successfully'
        };
    } catch (err) {
        await logError({
            function: 'cheerHandler',
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
