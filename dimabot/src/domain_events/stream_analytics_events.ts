import type { DomainEventEnvelope } from './domain_event.types.js';
import EventsubSchema from '../schemas/eventsub.schema.js';
import {
    recordStreamBitsEvent,
    recordStreamFollowEvent,
    recordStreamOfflineEvent,
    recordStreamOnlineEvent,
    recordStreamSubEvent,
    recordSubscriptionLedgerEnd,
    recordSubscriptionLedgerStart
} from '../utils/stream_analytics.js';
import { CANONICAL_BITS_EVENT_TYPE, isLegacyBitsEventType } from '../utils/eventsub.js';

interface SubscriptionEventData extends Record<string, unknown> {
    broadcaster_user_id?: string;
    broadcaster_user_login?: string;
    broadcaster_user_name?: string;
    user_id?: string;
    user_login?: string;
    user_name?: string;
    tier?: string;
    sub_tier?: string;
    subscription_tier?: string;
    is_gift?: boolean;
    total?: number;
}

function payloadRecord(event: DomainEventEnvelope, key: 'subscription' | 'event'): Record<string, unknown> {
    const value = event.payload[key];
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function resolveTier(source: SubscriptionEventData): string | undefined {
    const rawTier = source.tier ?? source.sub_tier ?? source.subscription_tier;
    return typeof rawTier === 'string' ? rawTier : undefined;
}

function resolveGiftQuantity(source: SubscriptionEventData): number {
    const total = Number(source.total);
    return Number.isFinite(total) && total > 0 ? Math.round(total) : 1;
}

async function shouldSkipLegacyBitsEvent(event: DomainEventEnvelope, originalEventType: string): Promise<boolean> {
    if (!isLegacyBitsEventType(originalEventType)) {
        return false;
    }

    const canonical = await EventsubSchema.findOne({
        channelID: event.channelID,
        type: CANONICAL_BITS_EVENT_TYPE,
        enabled: true
    }).sort({ created_at: 1 }).select('created_at').lean() as { created_at?: string } | null;
    if (!canonical) {
        return false;
    }

    const canonicalCreatedAt = new Date(String(canonical.created_at || '')).getTime();
    if (!Number.isFinite(canonicalCreatedAt)) {
        return true;
    }
    return canonicalCreatedAt <= event.occurredAt.getTime();
}

export async function applyStreamAnalyticsDomainEvent(event: DomainEventEnvelope): Promise<void> {
    if (event.source === 'twitch-eventsub-test') {
        return;
    }
    const rawEvent = payloadRecord(event, 'event') as SubscriptionEventData;
    const originalEventType = String(event.metadata.originalEventType || '');

    switch (event.type) {
        case 'channel.bits.received': {
            if (await shouldSkipLegacyBitsEvent(event, originalEventType)) {
                return;
            }
            const bits = Number(rawEvent.bits);
            if (Number.isFinite(bits) && bits > 0) {
                await recordStreamBitsEvent({
                    channelID: event.channelID,
                    bits: Math.round(bits),
                    occurredAt: event.occurredAt,
                    eventKey: event.eventKey
                });
            }
            return;
        }
        case 'channel.follow.received':
            await recordStreamFollowEvent({
                channelID: event.channelID,
                occurredAt: event.occurredAt,
                eventKey: event.eventKey
            });
            return;
        case 'channel.subscription.received':
            await recordSubscriptionLedgerStart({
                platform: 'twitch',
                streamer_id: event.channelID,
                streamer_login: String(rawEvent.broadcaster_user_login || ''),
                streamer_name: String(rawEvent.broadcaster_user_name || ''),
                user_id: String(rawEvent.user_id || ''),
                user_login: String(rawEvent.user_login || ''),
                user_name: String(rawEvent.user_name || ''),
                tier: resolveTier(rawEvent),
                is_gift: Boolean(rawEvent.is_gift),
                subbed_at: event.occurredAt,
                eventKey: event.eventKey
            });
            if (!rawEvent.is_gift) {
                await recordStreamSubEvent({
                    channelID: event.channelID,
                    quantity: 1,
                    tier: resolveTier(rawEvent),
                    occurredAt: event.occurredAt,
                    eventKey: event.eventKey
                });
            }
            return;
        case 'channel.subscription.gifted':
            await recordStreamSubEvent({
                channelID: event.channelID,
                quantity: resolveGiftQuantity(rawEvent),
                tier: resolveTier(rawEvent),
                occurredAt: event.occurredAt,
                eventKey: event.eventKey
            });
            return;
        case 'channel.subscription.ended':
            await recordSubscriptionLedgerEnd({
                platform: 'twitch',
                streamer_id: event.channelID,
                user_id: String(rawEvent.user_id || ''),
                ended_at: event.occurredAt,
                eventKey: event.eventKey
            });
            return;
        case 'stream.started': {
            const streamID = String(event.streamID || rawEvent.id || `stream-${event.channelID}-${event.occurredAt.toISOString()}`);
            await recordStreamOnlineEvent({
                channelID: event.channelID,
                channel: String(rawEvent.broadcaster_user_login || ''),
                streamID,
                startedAt: String(rawEvent.started_at || event.occurredAt.toISOString()),
                eventKey: event.eventKey,
                reopenClosed: false
            });
            return;
        }
        case 'stream.ended':
            await recordStreamOfflineEvent({
                channelID: event.channelID,
                endedAt: event.occurredAt,
                eventKey: event.eventKey
            });
            return;
        default:
            return;
    }
}
