import type { DomainEventEnvelope } from './domain_event.types.js';

interface ChatEventsubConfig {
    enabled: boolean;
    message: string;
    type: string;
    cheerTiers: Array<{
        name: string;
        message: string;
        min_amount: number;
        max_amount: number;
    }>;
    todayFollows?: boolean;
    [key: string]: unknown;
}

interface StreamerState {
    chat_enabled?: string;
    actived?: string;
    has_permissions?: string;
    refresh_token?: string;
    up_to_date_permissions?: string;
}

interface SendResult {
    error: boolean;
    message?: string;
    type?: string;
}

interface ChatMessageContext extends Record<string, unknown> {
    channelID: string;
}

export interface ChatAnnouncementDependencies {
    getStreamer(channelID: string): Promise<StreamerState | null>;
    getEventsubConfig(channelID: string, originalEventType: string): Promise<ChatEventsubConfig | null>;
    shouldSkipLegacyBits(event: DomainEventEnvelope, originalEventType: string): Promise<boolean>;
    incrementFollowCount(channelID: string, eventKey: string): Promise<number>;
    shouldSuppressFollowAlerts(channelID: string): Promise<boolean>;
    sendMessage(channelID: string, message: string, context?: ChatMessageContext): Promise<SendResult>;
    hasCommands(channelID: string): Promise<boolean>;
    getLanguage(channelID: string): Promise<'en' | 'es'>;
    hasNewerLifecycleEvent(event: DomainEventEnvelope): Promise<boolean>;
}

const FOLLOW_COUNT_TTL_SECONDS = 60 * 60 * 48;
const INCREMENT_FOLLOW_COUNT_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then return tonumber(existing) end
local count = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], tostring(count), 'EX', ARGV[1])
return count
`;
const SUPPORTED_EVENT_TYPES = new Set([
    'channel.bits.received',
    'channel.follow.received',
    'channel.subscription.received',
    'channel.subscription.gifted',
    'channel.subscription.ended',
    'stream.started',
    'stream.ended'
]);

let dependenciesPromise: Promise<ChatAnnouncementDependencies> | null = null;

async function getDependencies(): Promise<ChatAnnouncementDependencies> {
    dependenciesPromise ||= Promise.all([
        import('../classes/twitch_streamers.class.js'),
        import('../functions/chats/send_message.chat.js'),
        import('../schemas/commands.schema.js'),
        import('../schemas/domain_event.schema.js'),
        import('../schemas/eventsub.schema.js'),
        import('../schemas/users.schema.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/eventsub.js'),
        import('../utils/follow_defense_queue.js')
    ]).then(([
        { default: TwitchStreamers },
        { sendTwitchChatMessage },
        { CommandsSchema },
        { DomainEventSchema },
        { default: EventsubSchema },
        { default: UsersSchema },
        { getDragonflyClient },
        { CANONICAL_BITS_EVENT_TYPE, getEquivalentEventsubTypes, isLegacyBitsEventType },
        { shouldSuppressFollowAlerts }
    ]) => ({
        getStreamer: (channelID) => TwitchStreamers.getTwitchAccountById(channelID),
        async getEventsubConfig(channelID, originalEventType) {
            const equivalentTypes = getEquivalentEventsubTypes(originalEventType);
            const config = originalEventType === CANONICAL_BITS_EVENT_TYPE || isLegacyBitsEventType(originalEventType)
                ? await EventsubSchema.findOne({ channelID, type: CANONICAL_BITS_EVENT_TYPE })
                    || await EventsubSchema.findOne({
                        channelID,
                        type: { $in: equivalentTypes.filter((type) => type !== CANONICAL_BITS_EVENT_TYPE) }
                    })
                : await EventsubSchema.findOne({ channelID, type: originalEventType });
            return config as ChatEventsubConfig | null;
        },
        async shouldSkipLegacyBits(event, originalEventType) {
            if (!isLegacyBitsEventType(originalEventType)) return false;
            const canonical = await EventsubSchema.findOne({
                channelID: event.channelID,
                type: CANONICAL_BITS_EVENT_TYPE,
                enabled: true
            }).sort({ created_at: 1 }).select('created_at').lean() as { created_at?: string } | null;
            if (!canonical) return false;
            const createdAt = new Date(String(canonical.created_at || '')).getTime();
            return !Number.isFinite(createdAt) || createdAt <= event.occurredAt.getTime();
        },
        async incrementFollowCount(channelID, eventKey) {
            const cache = await getDragonflyClient('chatAnnouncementFollowCount');
            const result = await cache.eval(INCREMENT_FOLLOW_COUNT_SCRIPT, {
                keys: [`${channelID}:follows:count`, `${channelID}:follows:event:${eventKey}`],
                arguments: [String(FOLLOW_COUNT_TTL_SECONDS)]
            });
            const count = Number(result);
            if (!Number.isFinite(count) || count < 1) {
                throw new Error('Failed to assign a durable follow count');
            }
            return count;
        },
        shouldSuppressFollowAlerts,
        sendMessage: (channelID, message, context) => sendTwitchChatMessage(channelID, message, null, context),
        hasCommands: async (channelID) => Boolean(await CommandsSchema.exists({ channelID })),
        async getLanguage(channelID) {
            const user = await UsersSchema.findOne(
                { 'accounts.id': channelID, 'accounts.type': 'twitch' },
                { language: 1 }
            ).lean<{ language?: 'en' | 'es' | null }>();
            return user?.language === 'es' ? 'es' : 'en';
        },
        async hasNewerLifecycleEvent(event) {
            return Boolean(await DomainEventSchema.exists({
                channelID: event.channelID,
                source: { $ne: 'twitch-eventsub-test' },
                type: { $in: ['stream.started', 'stream.ended'] },
                $or: [
                    { occurredAt: { $gt: event.occurredAt } },
                    { occurredAt: event.occurredAt, _id: { $gt: event._id } }
                ]
            }));
        }
    }));
    return dependenciesPromise;
}

function payloadEvent(event: DomainEventEnvelope): Record<string, unknown> {
    const value = event.payload.event;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function originalEventType(event: DomainEventEnvelope): string {
    const original = String(event.metadata.originalEventType || '').trim();
    if (original) return original;
    if (event.type === 'channel.bits.received') return 'channel.bits.use';
    if (event.type === 'channel.follow.received') return 'channel.follow';
    if (event.type === 'channel.subscription.received') return 'channel.subscribe';
    if (event.type === 'channel.subscription.gifted') return 'channel.subscription.gift';
    if (event.type === 'channel.subscription.ended') return 'channel.subscription.end';
    if (event.type === 'stream.started') return 'stream.online';
    return 'stream.offline';
}

function defaultConfig(type: string): ChatEventsubConfig {
    return {
        enabled: true,
        message: '',
        type,
        cheerTiers: [],
        todayFollows: false
    };
}

function cheerMessage(config: ChatEventsubConfig, rawEvent: Record<string, unknown>): string {
    const bits = Number(rawEvent.bits);
    if (rawEvent.is_anonymous) {
        return config.message || `Gracias por los ${bits} bits Anonimo!`;
    }
    const tier = (config.cheerTiers || []).find((candidate) =>
        bits >= Number(candidate.min_amount) && bits <= Number(candidate.max_amount)
    );
    return tier ? tier.message : config.message || '';
}

export async function applyChatAnnouncementDomainEvent(
    event: DomainEventEnvelope,
    injectedDependencies?: ChatAnnouncementDependencies
): Promise<void> {
    if (event.source === 'twitch-eventsub-test'
        || event.metadata.durableChatHandled !== true
        || !SUPPORTED_EVENT_TYPES.has(event.type)) return;

    const dependencies = injectedDependencies || await getDependencies();
    if ((event.type === 'stream.started' || event.type === 'stream.ended')
        && await dependencies.hasNewerLifecycleEvent(event)) return;
    const streamer = await dependencies.getStreamer(event.channelID);
    if (!streamer || streamer.chat_enabled === 'false') return;

    const originalType = originalEventType(event);
    if (event.type === 'channel.bits.received'
        && await dependencies.shouldSkipLegacyBits(event, originalType)) return;

    const config = await dependencies.getEventsubConfig(event.channelID, originalType)
        || defaultConfig(originalType);
    if (!config.enabled) return;

    const rawEvent = payloadEvent(event);
    let message = config.message || '';
    let variables: Record<string, string> | undefined;

    if (event.type === 'channel.bits.received') {
        message = cheerMessage(config, rawEvent);
        variables = {
            bits: String(rawEvent.bits ?? ''),
            user: String(rawEvent.user_name || ''),
            userLogin: String(rawEvent.user_login || '')
        };
    } else if (event.type === 'channel.follow.received') {
        const count = await dependencies.incrementFollowCount(event.channelID, event.eventKey);
        if (await dependencies.shouldSuppressFollowAlerts(event.channelID)) return;
        if (config.todayFollows) message = `${config.message} (Follow #${count})`;
        variables = {
            user: String(rawEvent.user_name || ''),
            userLogin: String(rawEvent.user_login || ''),
            count: String(count)
        };
    }

    if (!message.trim()) return;
    const result = await dependencies.sendMessage(event.channelID, message, {
        channelID: event.channelID,
        eventData: rawEvent,
        eventsubData: config,
        variables
    });
    if (result.error) {
        throw new Error(`Sending ${originalType} chat announcement failed: ${result.message || result.type || 'unknown error'}`);
    }
}

export async function applyAccountHealthNotificationDomainEvent(
    event: DomainEventEnvelope,
    injectedDependencies?: ChatAnnouncementDependencies
): Promise<void> {
    if (event.source === 'twitch-eventsub-test'
        || event.metadata.durableChatHandled !== true
        || event.type !== 'stream.started') return;

    const dependencies = injectedDependencies || await getDependencies();
    if (await dependencies.hasNewerLifecycleEvent(event)) return;

    const streamer = await dependencies.getStreamer(event.channelID);
    if (!streamer || streamer.chat_enabled === 'false') return;
    const config = await dependencies.getEventsubConfig(event.channelID, 'stream.online')
        || defaultConfig('stream.online');
    if (!config.enabled || !await dependencies.hasCommands(event.channelID)) return;

    const language = await dependencies.getLanguage(event.channelID);
    let message = '';
    if (streamer.actived === 'false') {
        message = language === 'es'
            ? 'Tu cuenta fue desactivada. Por favor reactiva tu cuenta en https://domdimabot.com para seguir usando el bot.'
            : 'Your account got deactivated, please go ahead and reactivate your account on https://domdimabot.com to continue using the bot.';
    } else if (streamer.has_permissions !== 'true' || !streamer.refresh_token) {
        message = language === 'es'
            ? 'Tu token ha expirado y el bot no tiene permisos para gestionar tu canal. Por favor vuelve a autenticarte en el dashboard en https://domdimabot.com.'
            : 'Your token has expired and the bot does not have permissions to manage your channel, please reauthenticate on the dashboard at https://domdimabot.com.';
    } else if (streamer.up_to_date_permissions === 'false') {
        message = language === 'es'
            ? 'Hay nuevas funciones que requieren nuevos permisos de acceso. Por favor vuelve a autenticarte para darles acceso en https://domdimabot.com.'
            : 'There are new features that require new permission access, please reauthenticate to give access to them at https://domdimabot.com.';
    }

    if (!message) return;
    const result = await dependencies.sendMessage(event.channelID, message);
    if (result.error) {
        throw new Error(`Sending account health notification failed: ${result.message || result.type || 'unknown error'}`);
    }
}
