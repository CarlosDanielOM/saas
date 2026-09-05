import type { DomainEventProducer, JournalDomainEventInput } from './domain_event.types.js';
import { resolveDomainEventOwner } from './domain_event_identity.js';

interface TwitchEventsubSubscriptionLike {
    id?: string;
    type?: string;
    version?: string;
    [key: string]: unknown;
}

export interface NormalizeTwitchEventsubInput {
    messageId: string;
    messageTimestamp?: string;
    messageRetry?: number;
    staleRetry?: boolean;
    subscription: TwitchEventsubSubscriptionLike;
    event: Record<string, unknown>;
    source?: 'twitch-eventsub' | 'twitch-eventsub-test';
    durableChatHandled?: boolean;
}

const DURABLE_EVENT_TYPES: Record<string, string> = {
    'channel.bits.use': 'channel.bits.received',
    'channel.cheer': 'channel.bits.received',
    'channel.bit.use': 'channel.bits.received',
    'channel.follow': 'channel.follow.received',
    'channel.subscribe': 'channel.subscription.received',
    'channel.subscription.message': 'channel.subscription.received',
    'channel.subscription.gift': 'channel.subscription.gifted',
    'channel.subscription.end': 'channel.subscription.ended',
    'stream.online': 'stream.started',
    'stream.offline': 'stream.ended'
};

function firstString(...values: unknown[]): string {
    for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
    }
    return '';
}

function resolveOccurredAt(eventType: string, event: Record<string, unknown>, messageTimestamp?: string): string | undefined {
    if (eventType === 'channel.follow') {
        return firstString(event.followed_at, messageTimestamp) || undefined;
    }
    if (eventType === 'stream.online') {
        return firstString(event.started_at, messageTimestamp) || undefined;
    }
    return firstString(messageTimestamp) || undefined;
}

export function normalizeTwitchEventsubDomainEvent(
    input: NormalizeTwitchEventsubInput
): JournalDomainEventInput | null {
    const originalEventType = firstString(input.subscription.type);
    const normalizedType = DURABLE_EVENT_TYPES[originalEventType];
    if (!normalizedType) {
        return null;
    }

    const channelID = firstString(
        input.event.broadcaster_user_id,
        input.event.to_broadcaster_user_id
    );
    if (!channelID) {
        throw new Error(`Durable Twitch event ${originalEventType} is missing a channel ID`);
    }

    const streamID = originalEventType === 'stream.online'
        ? firstString(input.event.id)
        : undefined;

    return {
        source: input.source || 'twitch-eventsub',
        sourceEventId: firstString(input.messageId),
        type: normalizedType,
        topic: 'channel',
        schemaVersion: 1,
        subject: { provider: 'twitch', kind: 'streaming-account', id: channelID },
        channelID,
        streamID,
        occurredAt: resolveOccurredAt(originalEventType, input.event, input.messageTimestamp),
        payload: {
            subscription: input.subscription,
            event: input.event
        },
        metadata: {
            ...(input.durableChatHandled ? { durableChatHandled: true } : {}),
            originalEventType,
            subscriptionID: firstString(input.subscription.id),
            subscriptionVersion: firstString(input.subscription.version),
            messageTimestamp: firstString(input.messageTimestamp),
            messageRetry: input.messageRetry || 0,
            staleRetry: Boolean(input.staleRetry)
        }
    };
}

export function isDurableTwitchEventsubType(eventType: string): boolean {
    return Boolean(DURABLE_EVENT_TYPES[String(eventType || '').trim()]);
}

export const twitchEventsubProducer: DomainEventProducer<NormalizeTwitchEventsubInput> = {
    provider: 'twitch',
    normalize: normalizeTwitchEventsubDomainEvent,
    resolveOwner: (event) => event.subject ? resolveDomainEventOwner(event.subject) : Promise.resolve(undefined)
};
