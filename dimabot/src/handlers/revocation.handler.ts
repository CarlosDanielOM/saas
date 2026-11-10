import EventsubSchema from "../schemas/eventsub.schema.js";
import type { ITwitchSubscriptionData } from "../interfaces/twitch/eventsub.interface.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import { info as logInfo, warn as logWarn, error as logError } from "../utils/logger.js";
import UsersSchema from "../schemas/users.schema.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";

/**
 * Twitch revoked the bot's chat subscription (app access removed, account changes, failing
 * deliveries...). Without it the bot no longer reads that chat, so the site shows it as out
 * of chat and the streamer can add it again. Idempotent; errors propagate so the webhook
 * answers 503 and the subscription record stays for a replay to repair.
 */
async function markBotOutOfChat(channelID: string, revokedID: string): Promise<void> {
    // Another chat subscription (e.g. the streamer re-added the bot since) keeps it in chat.
    if (await EventsubSchema.exists({ channelID, type: 'channel.chat.message', id: { $ne: revokedID } })) return;
    await UsersSchema.updateOne({ 'accounts.id': channelID }, { $set: { 'accounts.$.chat_enabled': false } });
    const cache = await getDragonflyClient('Revocation');
    if (await cache.exists(`accounts:twitch:${channelID}:data`)) {
        await cache.hSet(`accounts:twitch:${channelID}:data`, 'chat_enabled', 'false');
    }
}

interface RevocationHandlerResponse {
    error: boolean;
    message: string;
}

export async function revocationHandler(
    subscriptionData: ITwitchSubscriptionData
): Promise<RevocationHandlerResponse> {
    try {
        const { id, type, version, condition } = subscriptionData;

        if (!id || !type || !version) {
            await logError({
                function: 'revocationHandler',
                error: 'Invalid subscription data: missing required fields',
                subscriptionData
            }, { channelId: 'unknown', destination: 'both' });

            return {
                error: true,
                message: 'Invalid subscription data'
            };
        }

        const subscription: IEventsub | null = await EventsubSchema.findOne({
            id,
            type,
            version
        });

        // The revocation is signature-verified, so its condition names the channel.
        const chatChannelID = type === 'channel.chat.message'
            ? String((condition as { broadcaster_user_id?: string } | undefined)?.broadcaster_user_id || '')
            : '';

        if (!subscription) {
            // A replay after a failed flag update: the record is gone, repair the flag.
            if (chatChannelID) {
                await markBotOutOfChat(chatChannelID, id);
            }
            await logWarn({
                message: 'EventSub subscription not found for revocation (already deleted?)',
                subscriptionId: id,
                type,
                version,
                condition
            }, { channelId: 'unknown', destination: 'both' });

            return {
                error: false,
                message: 'Subscription not found (already deleted)'
            };
        }

        await logInfo({
            message: 'EventSub subscription revoked - deleting from database',
            subscriptionId: id,
            type,
            version,
            channelID: subscription.channelID,
            channel: subscription.channel,
            condition
        }, { channelId: subscription.channelID || 'unknown', destination: 'both' });

        // Flag first: if it fails, the record stays so a replayed revocation can finish.
        if (type === 'channel.chat.message' && (subscription.channelID || chatChannelID)) {
            await markBotOutOfChat(subscription.channelID || chatChannelID, id);
        }

        await EventsubSchema.deleteOne({
            id,
            type,
            version
        });

        await logInfo({
            message: 'EventSub subscription deleted successfully',
            subscriptionId: id,
            type,
            version,
            channelID: subscription.channelID
        }, { channelId: subscription.channelID || 'unknown', destination: 'both' });

        return {
            error: false,
            message: 'Subscription revoked successfully'
        };
    } catch (err) {
        await logError({
            function: 'revocationHandler',
            subscriptionData,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { channelId: 'unknown', destination: 'both' });

        return {
            error: true,
            message: 'Internal server error'
        };
    }
}
