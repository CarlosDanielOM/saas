import ChatHistory from "../classes/chat_history.js";
import TwitchStreamers from "../classes/twitch_streamers.class.js";
import type { IChatMessage, ITwitchEventData, ITwitchSubscriptionData, IRaidEventData, IBitUseEvent, IRedemptionEvent, IFollowEvent, IStreamOnlineEvent, IStreamOfflineEvent, IAdBreakEvent, IBanEvent } from "../interfaces/twitch/eventsub.interface.js";
import EventsubSchema, { type IEventsub } from "../schemas/eventsub.schema.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import { messageHandler } from "./message.handler.js";
import { raidHandler } from "./raid.handler.js";
import { cheerHandler } from "./cheer.handler.js";
import { sendTwitchChatMessage } from "../functions/chats/send_message.chat.js";
import { redemptionHandler } from "./redemption.handler.js";
import { followHandler } from "./follow.handler.js";
import { streamOnlineHandler } from "./stream_online.handler.js";
import { streamOfflineHandler } from "./stream_offline.handler.js";
import { adBreakHandler } from "./ad_break.handler.js";
import { banHandler } from "./ban.handler.js";
import { error as logError, info as logInfo } from "../utils/logger.js";
import {
    CANONICAL_BITS_EVENT_TYPE,
    canonicalizeEventsubType,
    getEquivalentEventsubTypes,
    isLegacyBitsEventType,
    migrateLegacyBitsEventsubs
} from "../utils/eventsub.js";
import type { BitsEventsubMigrationResult } from "../utils/eventsub.js";
//* TODO Redeem handler
//* TODO Functions

interface EventsubHandlerOptions {
    durableChatHandled?: boolean;
}

export const eventsubHandler = async (
    subscriptionData: ITwitchSubscriptionData,
    eventData: ITwitchEventData,
    options: EventsubHandlerOptions = {}
) => {
    const cache = await getDragonflyClient('Eventsub');
    let chatEnabled = true;
    let STREAMER = await TwitchStreamers.getTwitchAccountById(eventData?.broadcaster_user_id ?? '');
    if(!STREAMER) {
        STREAMER = await TwitchStreamers.getTwitchAccountById((eventData as IRaidEventData)?.to_broadcaster_user_id ?? '');
        if(!STREAMER) {
            console.log({error: 'Streamer not found', user_id: eventData?.broadcaster_user_id ?? (eventData as IRaidEventData)?.to_broadcaster_user_id}, `(${eventData?.broadcaster_user_name ?? (eventData as IRaidEventData)?.to_broadcaster_user_name})`);
            return;
        }
    }

    if(STREAMER.chat_enabled == 'false') chatEnabled = false
    const immediateChatEnabled = chatEnabled && !options.durableChatHandled;

    const {type} = subscriptionData;
    const canonicalType = canonicalizeEventsubType(type);
    const equivalentTypes = getEquivalentEventsubTypes(type);

    let bitsMigrationResult: BitsEventsubMigrationResult | null = null;
    if (isLegacyBitsEventType(type)) {
        bitsMigrationResult = await migrateLegacyBitsEventsubs(STREAMER.id).catch(async (migrationError) => {
            console.error('Error migrating legacy bits eventsubs:', {
                type,
                channelID: STREAMER.id,
                error: migrationError instanceof Error ? migrationError.message : String(migrationError),
                stack: migrationError instanceof Error ? migrationError.stack : undefined,
                timestamp: new Date().toISOString()
            });

            await logError({
                function: 'eventsubHandler.migrateLegacyBitsEventsubs',
                type,
                channelID: STREAMER.id,
                error: migrationError instanceof Error ? migrationError.message : String(migrationError),
                stack: migrationError instanceof Error ? migrationError.stack : undefined,
                timestamp: new Date().toISOString()
            }, { channelId: STREAMER.id, destination: 'both' });

            return null;
        });
    }

    const shouldSkipLegacyBitsEvent = isLegacyBitsEventType(type)
        && Boolean(bitsMigrationResult?.hadCanonicalBeforeMigration);

    if (shouldSkipLegacyBitsEvent) {
        await logInfo({
            message: 'Skipping legacy bits event because canonical subscription exists',
            type,
            canonicalType,
            channelID: STREAMER.id
        }, { channelId: STREAMER.id, destination: 'both' });
        return;
    }

    let eventsubData: IEventsub | null = null;

    if (canonicalType === CANONICAL_BITS_EVENT_TYPE) {
        eventsubData = bitsMigrationResult?.canonicalEventsub
            || await EventsubSchema.findOne({ channelID: STREAMER.id, type: CANONICAL_BITS_EVENT_TYPE })
            || await EventsubSchema.findOne({ channelID: STREAMER.id, type: { $in: equivalentTypes.filter((eventType) => eventType !== CANONICAL_BITS_EVENT_TYPE) } });
    } else {
        eventsubData = await EventsubSchema.findOne({
            channelID: STREAMER.id,
            type: canonicalType
        });
    }

    if(!eventsubData) {
        eventsubData = {
            id: '',
            status: '',
            type: canonicalType,
            version: '',
            condition: {},
            created_at: '',
            transport: {
                method: '',
                callback: ''
            },
            cost: 0,
            channel: '',
            channelID: '',
            enabled: true,
            message: '',
            endMessage: '',
            endEnabled: false,
            minViewers: 0,
            temporalBanMessage: '',
            clipEnabled: false,
            delay: 0,
            cheerTiers: []
        }
        await logInfo({
            message: 'No data found for eventsub',
            type,
            condition: subscriptionData.condition
        }, { channelId: STREAMER.id, destination: 'both' });
        // logger({channelID: STREAMER.id, channel: STREAMER.name, error: 'No data found', type, condition: subscriptionData.condition}, true, STREAMER.id, 'eventsub not found');
        console.log({error: 'No data found', type, condition: subscriptionData.condition});
    }

    if(!eventsubData.enabled) return;

    const handleMessageOnlyEvent = async () => {
        if (!chatEnabled) return;

        const event = eventData as unknown as Record<string, unknown>;
        const channelID = String(
            event.broadcaster_user_id ||
            event.to_broadcaster_user_id ||
            STREAMER.id
        );

        if (!channelID || !eventsubData?.message) return;

        await sendTwitchChatMessage(channelID, eventsubData.message, null, {
            channelID,
            eventData,
            eventsubData
        });
    };

    switch(type) {
        case 'channel.chat.message':
            messageHandler(STREAMER.id, eventData as IChatMessage);
            break;
        case 'channel.raid':
            await raidHandler(eventData as IRaidEventData, eventsubData);
            break;
        case CANONICAL_BITS_EVENT_TYPE:
        case 'channel.bit.use':
        case 'channel.cheer':
            await cheerHandler(eventData as IBitUseEvent, eventsubData, immediateChatEnabled);
            break;
        case 'channel.channel_points_custom_reward_redemption.add':
            await redemptionHandler(eventData as IRedemptionEvent, chatEnabled);
            break;
        case 'channel.follow':
            await followHandler(eventData as IFollowEvent, eventsubData, immediateChatEnabled);
            break;
        case 'stream.online':
            if (!options.durableChatHandled) {
                await streamOnlineHandler(eventData as IStreamOnlineEvent, eventsubData, chatEnabled);
            }
            break;
        case 'stream.offline':
            if (!options.durableChatHandled) {
                await streamOfflineHandler(eventData as IStreamOfflineEvent, eventsubData, chatEnabled);
            }
            break;
        case 'channel.ad_break.begin':
            adBreakHandler(eventData as IAdBreakEvent, eventsubData, chatEnabled);
            break;
        case 'channel.ban':
            banHandler(eventData as IBanEvent, eventsubData, chatEnabled);
            break;
        case 'channel.subscribe':
        case 'channel.subscription.gift':
        case 'channel.subscription.message':
        case 'channel.subscription.end':
            if (!options.durableChatHandled) {
                await handleMessageOnlyEvent();
            }
            break;
        case 'channel.shoutout.receive':
        case 'channel.hype_train.begin':
        case 'channel.hype_train.progress':
        case 'channel.hype_train.end':
        case 'channel.poll.progress':
        case 'channel.prediction.progress':
        case 'channel.update':
        case 'user.update':
        case 'automod.message.hold':
            await handleMessageOnlyEvent();
            break;
    }
}
