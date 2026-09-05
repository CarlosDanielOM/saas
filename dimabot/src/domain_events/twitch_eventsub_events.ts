import type { DomainEventProducer, JournalDomainEventInput } from './domain_event.types.js';
import { resolveDomainEventOwner } from './domain_event_identity.js';
import { DomainEventContractError, TWITCH_DOMAIN_EVENT_TYPES } from './domain_event_contracts.js';
export type { TwitchEventsubPayload } from './domain_event_contracts.js';

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
    durableDefenseHandled?: boolean;
}

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
    if (typeof input?.subscription?.type !== 'string' || !input.subscription.type.trim()) {
        throw new DomainEventContractError('Twitch subscription.type is required');
    }
    const originalEventType = firstString(input.subscription.type);
    const normalizedType = Object.hasOwn(TWITCH_DOMAIN_EVENT_TYPES, originalEventType)
        ? TWITCH_DOMAIN_EVENT_TYPES[originalEventType as keyof typeof TWITCH_DOMAIN_EVENT_TYPES] : undefined;
    if (!normalizedType) {
        return null;
    }
    if (typeof input.messageId !== 'string' || !input.messageId.trim()) {
        throw new DomainEventContractError('Twitch messageId is required');
    }
    if (input.source !== undefined && input.source !== 'twitch-eventsub' && input.source !== 'twitch-eventsub-test') {
        throw new DomainEventContractError('Invalid Twitch producer source');
    }
    if (!input.event || typeof input.event !== 'object' || Array.isArray(input.event)) {
        throw new DomainEventContractError('Twitch event must be a record');
    }

    const channelID = firstString(originalEventType === 'channel.raid'
        ? input.event.to_broadcaster_user_id : input.event.broadcaster_user_id);
    if (!channelID) {
        throw new DomainEventContractError(`Durable Twitch event ${originalEventType} is missing a channel ID`);
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
            ...(input.durableDefenseHandled && (input.source || 'twitch-eventsub') === 'twitch-eventsub'
                && (originalEventType === 'channel.follow' || originalEventType === 'channel.raid')
                ? { durableDefenseHandled: true } : {}),
            originalEventType,
            subscriptionID: firstString(input.subscription.id),
            subscriptionVersion: firstString(input.subscription.version),
            messageTimestamp: firstString(input.messageTimestamp),
            messageRetry: input.messageRetry ?? 0,
            staleRetry: input.staleRetry ?? false
        }
    };
}

export function isDurableTwitchEventsubType(eventType: string): boolean {
    return Object.hasOwn(TWITCH_DOMAIN_EVENT_TYPES, String(eventType || '').trim());
}

export const twitchEventsubProducer: DomainEventProducer<NormalizeTwitchEventsubInput> = {
    provider: 'twitch',
    normalize: normalizeTwitchEventsubDomainEvent,
    resolveOwner: (event) => event.subject ? resolveDomainEventOwner(event.subject) : Promise.resolve(undefined)
};
