import ChatHistory from "../classes/chat_history.js";
import TwitchStreamers from "../classes/twitch_streamers.class.js";
import type { IChatMessage, ITwitchEventData, ITwitchSubscriptionData, IRaidEventData, IBitUseEvent, IRedemptionEvent, IFollowEvent, IStreamOnlineEvent, IStreamOfflineEvent, IAdBreakEvent, IBanEvent } from "../interfaces/twitch/eventsub.interface.js";
import EventsubSchema, { type IEventsub } from "../schemas/eventsub.schema.js";
import UsersSchema from "../schemas/users.schema.js";
import { isSupportedChatNotice, resolveChatNotificationMessage } from "../utils/chat_notification_defaults.js";
import { getDragonflyClient } from "../utils/databases/dragonfly.database.js";
import { messageHandler } from "./message.handler.js";
import { keywordIndexCache } from '../utils/keyword_cache.js';
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
import { raidDirection } from '../utils/raid_direction.js';
import { isForeignSharedChatEvent } from '../utils/shared_chat_origin.js';
import type { AstEffectContext } from '../utils/ast_parser/effects.js';
import { publishWidgetChatEvent } from '../widget_feed/publisher.js';
import { REDEMPTION_EVENT_TYPE, chatSendDecision, recordAlert, recordRedemption, type AlertDecision } from '../utils/activity_events.js';
import { eventSnapshot, noteInteractionEvent } from '../utils/twitch_interactions.js';
import { claimInteraction } from '../utils/interaction_dispositions.js';
//* TODO Redeem handler
//* TODO Functions

interface EventsubHandlerOptions {
    chatEffectContext?: AstEffectContext;
    durableChatHandled?: boolean;
    durableDefenseHandled?: boolean;
    /** A signed Twitch retry older than the normal window (accepted only because the event is journaled). */
    staleRetry?: boolean;
    /** Twitch message id; absent for manual event tests. */
    messageId?: string;
}

// Alerts sent here rather than by the durable chat-announcements consumer.
const IMMEDIATE_ALERT_TYPES = new Set([
    'channel.hype_train.begin', 'channel.hype_train.progress', 'channel.hype_train.end', 'channel.shoutout.receive',
    'channel.poll.progress', 'channel.prediction.progress', 'channel.update', 'user.update', 'automod.message.hold',
    'channel.ban', 'channel.ad_break.begin', 'channel.poll.end', 'channel.prediction.end'
]);
// Announced by the consumer in production; here only for manual event tests.
const CONSUMER_ALERT_TYPES = new Set([
    'channel.follow', 'channel.subscribe', 'channel.subscription.gift', 'channel.subscription.message', 'channel.subscription.end'
]);

export const eventsubHandler = async (
    subscriptionData: ITwitchSubscriptionData,
    eventData: ITwitchEventData,
    options: EventsubHandlerOptions = {}
) => {
    // Shared-chat receiver copies belong in the visual feed, but must never run bot actions.
    if (isForeignSharedChatEvent(subscriptionData.type, eventData)) {
        if (subscriptionData.type === 'channel.chat.message') {
            void publishWidgetChatEvent(eventData.broadcaster_user_id ?? '', 'chat', eventData);
        }
        return;
    }

    // Poll and prediction notifications replace the snapshot the poll.* / prediction.* functions read,
    // whatever the chat settings are. A late retry never puts old numbers back, and a manual event
    // test (no Twitch message id) is never stored: its made-up poll must not look like the channel's.
    const interaction = options.staleRetry || !/^channel\.(poll|prediction)\./.test(subscriptionData.type) ? null
        : options.messageId ? await noteInteractionEvent(String(eventData?.broadcaster_user_id ?? ''), subscriptionData.type, eventData)
        : eventSnapshot(subscriptionData.type, eventData, Date.now());

    // Feed-only events bypass announcement configuration and all command/history side effects.
    // Chat reaches custom widgets even when the bot's chat handling is turned off for this channel.
    switch (subscriptionData.type) {
        case 'channel.chat.message':
            void publishWidgetChatEvent(eventData.broadcaster_user_id ?? '', 'chat', eventData);
            break;
        case 'channel.chat.message_delete':
            void publishWidgetChatEvent(eventData.broadcaster_user_id ?? '', 'chat.delete', eventData);
            return;
        case 'channel.chat.clear_user_messages':
        case 'channel.chat.clear':
            void publishWidgetChatEvent(eventData.broadcaster_user_id ?? '', 'chat.clear', eventData);
            return;
    }

    // Production notices announce through the durable consumer. Manual event
    // tests use this immediate path; other chat notice types have no effects.
    if (subscriptionData.type === 'channel.chat.notification'
        && (options.durableChatHandled || !isSupportedChatNotice((eventData as unknown as Record<string, unknown>).notice_type))) return;

    if (subscriptionData.type === 'channel.raid' && raidDirection(subscriptionData.condition) === 'outgoing') {
        const raid = eventData as IRaidEventData;
        const config = await EventsubSchema.findOne({ channelID: raid.from_broadcaster_user_id, type: 'channel.raid',
            'condition.from_broadcaster_user_id': raid.from_broadcaster_user_id,
            ...(subscriptionData.id ? { id: subscriptionData.id } : {}) }).lean();
        // The alert is about the channel that was raided. No config means nothing to announce (or a deleted account): no row.
        const noteRaid = (decision: AlertDecision) => recordAlert({ type: 'channel.raid', channelID: raid.from_broadcaster_user_id,
            payload: raid, ref: options.messageId, data: { direction: 'outgoing' },
            actor: { id: raid.to_broadcaster_user_id, login: raid.to_broadcaster_user_login, name: raid.to_broadcaster_user_name } }, decision);
        if (!config) return;
        if (!config.enabled) return noteRaid({ outcome: 'skipped', reason: 'alert_disabled' });
        if (!config.message.trim()) return noteRaid({ outcome: 'skipped', reason: 'empty_message' });
        const streamer = await TwitchStreamers.getTwitchAccountById(raid.from_broadcaster_user_id);
        if (!streamer) return;
        if (streamer.chat_enabled === 'false') return noteRaid({ outcome: 'skipped', reason: 'chat_disabled' });
        const sent = await sendTwitchChatMessage(raid.from_broadcaster_user_id, config.message, null, {
            channelID: raid.from_broadcaster_user_id, eventsubData: config,
            eventData: { ...raid, raid_direction: 'outgoing', broadcaster_user_id: raid.from_broadcaster_user_id,
                broadcaster_user_name: raid.from_broadcaster_user_name, broadcaster_user_login: raid.from_broadcaster_user_login,
                user_id: raid.to_broadcaster_user_id, user_name: raid.to_broadcaster_user_name, user_login: raid.to_broadcaster_user_login }
        }, { origin: 'alert' });
        noteRaid(chatSendDecision(sent));
        return;
    }

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
    // Cache lifecycle is independent of announcement settings and durable chat ownership.
    if (type === 'stream.online' && chatEnabled) await keywordIndexCache.get(STREAMER.id);
    if (type === 'stream.offline') keywordIndexCache.invalidate(STREAMER.id);
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
            type: canonicalType,
            ...(type === 'channel.raid' ? { 'condition.to_broadcaster_user_id': STREAMER.id } : {})
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

    const alertHere = IMMEDIATE_ALERT_TYPES.has(type) || (CONSUMER_ALERT_TYPES.has(type) && !options.durableChatHandled);
    const noteAlert = (decision: AlertDecision) => recordAlert({ type, channelID: STREAMER.id, payload: eventData, ref: options.messageId }, decision);

    if(!eventsubData.enabled) {
        if (alertHere) noteAlert({ outcome: 'skipped', reason: 'alert_disabled' });
        if (type === REDEMPTION_EVENT_TYPE) {
            recordRedemption(eventData, options.messageId, { outcome: 'skipped', reason: 'subscription_disabled', managed: true, action: 'none' });
        }
        return;
    }

    const handleMessageOnlyEvent = async () => {
        if (!chatEnabled) return noteAlert({ outcome: 'skipped', reason: 'chat_disabled' });

        const event = eventData as unknown as Record<string, unknown>;
        const channelID = String(
            event.broadcaster_user_id ||
            event.to_broadcaster_user_id ||
            STREAMER.id
        );

        if (!channelID || !eventsubData?.message) return noteAlert({ outcome: 'skipped', reason: 'empty_message' });

        const result = await sendTwitchChatMessage(channelID, eventsubData.message, null, {
            channelID,
            eventData,
            eventsubData
        }, { origin: 'alert' });
        noteAlert(chatSendDecision(result));
    };

    switch(type) {
        case 'channel.chat.notification': {
            if (!chatEnabled) break;
            const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: STREAMER.id } } })
                .select('language').lean();
            const message = resolveChatNotificationMessage((eventData as unknown as Record<string, unknown>).notice_type,
                eventsubData, user?.language === 'es' ? 'es' : 'en');
            if (!message) break;
            await sendTwitchChatMessage(STREAMER.id, message, null, {
                channelID: STREAMER.id, eventData, eventsubData
            }, { origin: 'alert' });
            break;
        }
        case 'channel.chat.message':
            messageHandler(STREAMER.id, eventData as IChatMessage, options.chatEffectContext);
            break;
        case 'channel.raid':
            await raidHandler(eventData as IRaidEventData, eventsubData, options);
            break;
        case CANONICAL_BITS_EVENT_TYPE:
        case 'channel.bit.use':
        case 'channel.cheer':
            await cheerHandler(eventData as IBitUseEvent, eventsubData, immediateChatEnabled);
            break;
        case 'channel.channel_points_custom_reward_redemption.add':
            await redemptionHandler(eventData as IRedemptionEvent, chatEnabled, options.messageId);
            break;
        case 'channel.follow':
            await followHandler(eventData as IFollowEvent, eventsubData, immediateChatEnabled, options);
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
            // Late retries still update widget state (journal) but never announce an old ad break.
            if (!options.staleRetry) adBreakHandler(eventData as IAdBreakEvent, eventsubData, chatEnabled, options.messageId);
            else noteAlert({ outcome: 'skipped', reason: 'stale' });
            break;
        case 'channel.ban':
            banHandler(eventData as IBanEvent, eventsubData, chatEnabled, options.messageId);
            break;
        case 'channel.subscribe':
        case 'channel.subscription.gift':
        case 'channel.subscription.message':
        case 'channel.subscription.end':
            if (!options.durableChatHandled) {
                await handleMessageOnlyEvent();
            }
            break;
        case 'channel.hype_train.begin':
        case 'channel.hype_train.progress':
        case 'channel.hype_train.end':
            if (!options.staleRetry) await handleMessageOnlyEvent();
            else noteAlert({ outcome: 'skipped', reason: 'stale' });
            break;
        case 'channel.poll.end':
        case 'channel.prediction.end':
            // "Poll ended" / "Prediction ended" run once per poll or prediction that has a result:
            // a canceled one stays silent, and so does the second end notification Twitch sends
            // when a finished poll is dismissed (archived).
            if (options.staleRetry) { noteAlert({ outcome: 'skipped', reason: 'stale' }); break; }
            if (interaction?.status !== 'ended') break;
            // Never written (the overlay widgets create these subscriptions with an empty message): nothing to send or record.
            if (!eventsubData.message?.trim()) break;
            // Manual tests may run again and again; a real poll or prediction runs its script once, and
            // never after it was canceled. If the claim cannot be saved this throws and nothing runs.
            if (options.messageId && !await claimInteraction(STREAMER.id, interaction.kind, interaction.id, 'announced')) break;
            await handleMessageOnlyEvent();
            break;
        case 'channel.shoutout.receive':
        case 'channel.poll.progress':
        case 'channel.prediction.progress':
        case 'channel.update':
        case 'user.update':
        case 'automod.message.hold':
            await handleMessageOnlyEvent();
            break;
    }
}
