import { sendTwitchChatMessage, type SendMessageContext } from "../functions/chats/send_message.chat.js";
import type { IEventsub } from "../schemas/eventsub.schema.js";
import type { IStreamOnlineEvent } from "../interfaces/twitch/eventsub.interface.js";
import { getChannelEditors } from "../functions/channels/get_editors.channel.js";
import { unVIPExpiredUser } from "../functions/redemptions/unvipexpired.redemption.js";
import { incrementSiteAnalytics } from "../utils/siteanalytics.js";
import TwitchStreamers from "../classes/twitch_streamers.class.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import { recordStreamOnlineEvent } from "../utils/stream_analytics.js";
import { loadChannelTimersIntoCache } from "../utils/timer_cache.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import { loadChannelAdminsIntoCache } from "../utils/cache.js";
import { CommandsSchema } from "../schemas/commands.schema.js";
import UsersSchema from "../schemas/users.schema.js";

const STREAM_ONLINE_DEDUPE_TTL_SECONDS = Math.max(60 * 60, Number(process.env.STREAM_ONLINE_DEDUPE_TTL_SECONDS || 60 * 60 * 24));

interface StreamOnlineHandlerResponse {
    error: boolean;
    message: string;
}

export async function streamOnlineHandler(
    eventData: IStreamOnlineEvent,
    eventsubData: IEventsub,
    chatEnabled: boolean
): Promise<StreamOnlineHandlerResponse> {
    try {
        const { broadcaster_user_id, broadcaster_user_login } = eventData;
        const streamID = String(eventData.id || `stream-${broadcaster_user_id}-${eventData.started_at || 'unknown'}`);
        const cache = await getDragonflyClient('streamOnlineHandler');
        const dedupeKey = `twitch:${broadcaster_user_id}:stream.online:${streamID}`;
        const dedupeResult = await cache.set(dedupeKey, String(eventData.started_at || new Date().toISOString()), {
            NX: true,
            EX: STREAM_ONLINE_DEDUPE_TTL_SECONDS
        });

        if (dedupeResult !== 'OK') {
            await logInfo({
                message: 'Duplicate stream.online notification ignored',
                channelID: broadcaster_user_id,
                streamID
            }, { channelId: broadcaster_user_id, destination: 'cache' });

            return {
                error: false,
                message: 'Duplicate stream.online notification ignored'
            };
        }

        if (!chatEnabled) {
            await logInfo({
                message: 'Chat disabled - calling recordStreamOnlineEvent',
                channelID: broadcaster_user_id,
                streamID
            }, { channelId: broadcaster_user_id, destination: 'both' });

            await recordStreamOnlineEvent({
                channelID: broadcaster_user_id,
                channel: broadcaster_user_login,
                streamID,
                startedAt: eventData.started_at
            });
            await loadChannelTimersIntoCache(broadcaster_user_id);
            await getChannelEditors(broadcaster_user_id, true);
            await loadChannelAdminsIntoCache(broadcaster_user_id);
            await unVIPExpiredUser(eventData);
            await incrementSiteAnalytics('live', 1);
            return {
                error: false,
                message: 'Chat is disabled'
            };
        }

        const streamer = await TwitchStreamers.getTwitchAccountById(broadcaster_user_id);

        if (eventsubData.message) {
            const context: SendMessageContext = {
                channelID: broadcaster_user_id,
                eventData: eventData
            };

            await sendTwitchChatMessage(broadcaster_user_id, eventsubData.message, null, context);
        }

        // Account health notification (only for channels that have custom commands).
        // Sent after any custom stream.online message. Deduped once per stream via the existing key.
        // Priority: deactivated > (missing permissions or invalid refresh token) > outdated permissions.
        // Language comes from the user's language preference (fallback to 'en').
        const hasCommands = await CommandsSchema.exists({ channelID: broadcaster_user_id });
        if (hasCommands && streamer) {
            const userLangDoc = await UsersSchema.findOne(
                { 'accounts.id': broadcaster_user_id, 'accounts.type': 'twitch' },
                { language: 1 }
            ).lean<{ language?: 'en' | 'es' | null }>();

            const lang: 'en' | 'es' = userLangDoc?.language === 'es' ? 'es' : 'en';

            const isDeactivated = streamer.actived === 'false';
            const hasPerms = streamer.has_permissions === 'true';
            const hasRefreshToken = !!streamer.refresh_token;

            let healthMessage: string | null = null;
            let reason: string | null = null;

            if (isDeactivated) {
                healthMessage = lang === 'es'
                    ? 'Tu cuenta fue desactivada. Por favor reactiva tu cuenta en https://domdimabot.com para seguir usando el bot.'
                    : 'Your account got deactivated, please go ahead and reactivate your account on https://domdimabot.com to continue using the bot.';
                reason = 'deactivated';
            } else if (!hasPerms || !hasRefreshToken) {
                healthMessage = lang === 'es'
                    ? 'Tu token ha expirado y el bot no tiene permisos para gestionar tu canal. Por favor vuelve a autenticarte en el dashboard en https://domdimabot.com.'
                    : 'Your token has expired and the bot does not have permissions to manage your channel, please reauthenticate on the dashboard at https://domdimabot.com.';
                reason = 'expired_token_or_permissions';
            } else if (streamer.up_to_date_permissions === 'false') {
                healthMessage = lang === 'es'
                    ? 'Hay nuevas funciones que requieren nuevos permisos de acceso. Por favor vuelve a autenticarte para darles acceso en https://domdimabot.com.'
                    : 'There are new features that require new permission access, please reauthenticate to give access to them at https://domdimabot.com.';
                reason = 'outdated_permissions';
            }

            if (healthMessage) {
                await sendTwitchChatMessage(broadcaster_user_id, healthMessage);

                await logInfo({
                    message: 'Account health warning sent',
                    channelID: broadcaster_user_id,
                    reason
                }, { channelId: broadcaster_user_id, destination: 'both' });
            }
        }

        await getChannelEditors(broadcaster_user_id, true);

        await loadChannelAdminsIntoCache(broadcaster_user_id);

        await unVIPExpiredUser(eventData);

        await logInfo({
            message: 'About to call recordStreamOnlineEvent',
            channelID: broadcaster_user_id,
            streamID,
            startedAt: eventData.started_at
        }, { channelId: broadcaster_user_id, destination: 'both' });

        await recordStreamOnlineEvent({
            channelID: broadcaster_user_id,
            channel: broadcaster_user_login,
            streamID,
            startedAt: eventData.started_at
        });

        await logInfo({
            message: 'recordStreamOnlineEvent completed',
            channelID: broadcaster_user_id,
            streamID
        }, { channelId: broadcaster_user_id, destination: 'both' });

        await loadChannelTimersIntoCache(broadcaster_user_id);

        await incrementSiteAnalytics('live', 1);

        await logInfo({
            message: 'Stream went online',
            channelID: broadcaster_user_id
        }, { channelId: broadcaster_user_id, destination: 'both' });

        return {
            error: false,
            message: 'Stream online handled'
        };
    } catch (err) {
        await logError({
            function: 'streamOnlineHandler',
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
