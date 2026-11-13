import { recordActivity, type ActivityInput } from './activity_log.js';
import type { ActivityOutcome } from '../schemas/activity_log.schema.js';

/**
 * Activity rows for Twitch notifications and chat alerts. The builders are pure (tests use them);
 * the `record*` wrappers are what handlers call: synchronous and unable to throw into the caller.
 */

export const REDEMPTION_EVENT_TYPE = 'channel.channel_points_custom_reward_redemption.add';

/**
 * Handled Twitch types that no other store keeps. Durable types are journaled in `domain_events`,
 * chat messages are stored elsewhere and are far too many, and redemptions are written by the
 * redemption handler, which knows what it did with them.
 */
const UNJOURNALED_EVENT_TYPES = new Set([
    'channel.update',
    'user.update',
    'channel.ban',
    'channel.shoutout.receive',
    'automod.message.hold',
    'channel.chat.clear',
    'channel.chat.clear_user_messages',
    'channel.chat.message_delete'
]);

export type AlertSkipReason = 'chat_disabled' | 'alert_disabled' | 'follow_defense' | 'empty_message' | 'stale';
export type AlertFailReason = 'send_failed' | 'handler_error';
export type RedemptionAction = 'message' | 'trigger' | 'vip' | 'none';

type Event = Record<string, unknown>;
type Actor = NonNullable<ActivityInput['actor']>;

const str = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const obj = (value: unknown): Event => value && typeof value === 'object' ? value as Event : {};
const errorText = (error: unknown): string => error instanceof Error ? error.message : str(error) || 'unknown error';

function actorFrom(event: Event, prefix: string): Actor | null {
    const id = str(event[`${prefix}_id`]);
    const login = str(event[`${prefix}_login`]);
    if (!id && !login) return null;
    return { id, login, name: str(event[`${prefix}_name`]) };
}

/** The viewer an event is about, when there is one. */
export function eventActor(type: string, payload: unknown): Actor | null {
    const event = obj(payload);
    switch (type) {
        case 'channel.shoutout.receive': return actorFrom(event, 'from_broadcaster_user');
        case 'channel.raid': return actorFrom(event, 'from_broadcaster_user');
        case 'channel.chat.clear_user_messages':
        case 'channel.chat.message_delete': return actorFrom(event, 'target_user');
        case 'channel.chat.notification': return event.chatter_is_anonymous ? null : actorFrom(event, 'chatter_user');
        case 'channel.update':
        case 'channel.chat.clear':
        case 'stream.online':
        case 'stream.offline': return null;
        default: return event.is_anonymous ? null : actorFrom(event, 'user');
    }
}

/** The channel a notification belongs to (user.update carries the streamer as `user_id`). */
export function eventChannelID(type: string, payload: unknown, condition?: unknown): string {
    const event = obj(payload);
    const direct = str(event.broadcaster_user_id);
    if (direct) return direct;
    if (type === 'user.update') return str(event.user_id);
    return str(obj(condition).from_broadcaster_user_id) ? str(event.from_broadcaster_user_id) : str(event.to_broadcaster_user_id);
}

function eventFacts(type: string, event: Event): { data: Record<string, unknown>; text?: string } {
    switch (type) {
        case 'channel.update':
            return { data: { title: str(event.title), category: str(event.category_name) } };
        case 'channel.ban':
            return { data: { moderator: str(event.moderator_user_login), reason: str(event.reason), permanent: event.is_permanent === true } };
        case 'channel.shoutout.receive':
            return { data: { from: str(event.from_broadcaster_user_login), viewers: Number(event.viewer_count) || 0 } };
        case 'automod.message.hold': {
            // v1 puts category and level at the top, v2 under `automod`.
            const automod = obj(event.automod);
            return {
                data: { category: str(event.category) || str(automod.category), level: Number(event.level ?? automod.level) || null },
                text: str(obj(event.message).text)
            };
        }
        case 'channel.chat.message_delete':
            return { data: { messageId: str(event.message_id) } };
        default:
            return { data: {} };
    }
}

/**
 * Row for a Twitch notification that is not journaled, or null when this type is not recorded here
 * (journaled types, chat messages, redemptions and anything unknown).
 */
export function twitchEventActivity(type: string, messageId: string, payload: unknown, condition?: unknown): ActivityInput | null {
    if (!UNJOURNALED_EVENT_TYPES.has(type)) return null;
    const event = obj(payload);
    const facts = eventFacts(type, event);
    return {
        kind: 'twitch_event',
        name: type,
        channelID: eventChannelID(type, event, condition),
        actor: eventActor(type, event),
        ref: messageId,
        dedupeKey: messageId || null,
        text: facts.text || null,
        data: facts.data
    };
}

/** A handler that crashed after Twitch already got its 204. `ref` is the event key or the message id. */
export function handlerErrorActivity(type: string, channelID: string, ref: string, error: unknown): ActivityInput {
    return {
        kind: 'twitch_event',
        name: type,
        channelID,
        outcome: 'failed',
        reason: 'handler_error',
        ref,
        dedupeKey: ref ? `${ref}:handler_error` : null,
        data: { error: errorText(error) }
    };
}

export interface RedemptionOutcome {
    outcome: ActivityOutcome;
    reason?: string;
    /** Whether Dima has a record for this reward (one it created and manages). */
    managed: boolean;
    action: RedemptionAction;
    trigger?: string;
    /** Whether the bot may speak in this chat; without it a reward runs but says nothing. */
    chatEnabled?: boolean;
    error?: unknown;
}

export function redemptionActivity(payload: unknown, messageId: string | undefined, result: RedemptionOutcome): ActivityInput {
    const event = obj(payload);
    const reward = obj(event.reward);
    const redemptionId = str(event.id);
    return {
        kind: 'twitch_event',
        name: REDEMPTION_EVENT_TYPE,
        channelID: str(event.broadcaster_user_id),
        outcome: result.outcome,
        reason: result.reason || null,
        actor: eventActor(REDEMPTION_EVENT_TYPE, event),
        ref: messageId || redemptionId,
        // A retried delivery has the same message id; a redemption run without one (event tests) still has its own id.
        dedupeKey: messageId || (redemptionId ? `redemption:${redemptionId}` : null),
        // The viewer's text is kept only when Dima acts on the reward.
        text: result.managed ? str(event.user_input) || null : null,
        data: {
            rewardTitle: str(reward.title),
            rewardCost: Number(reward.cost) || 0,
            rewardId: str(reward.id),
            status: str(event.status),
            redemptionId,
            managed: result.managed,
            action: result.action,
            ...(result.chatEnabled !== undefined ? { chatEnabled: result.chatEnabled } : {}),
            ...(result.trigger ? { trigger: result.trigger } : {}),
            ...(result.error !== undefined ? { error: errorText(result.error) } : {})
        }
    };
}

export type AlertDecision =
    | { outcome: 'ok' }
    | { outcome: 'skipped'; reason: AlertSkipReason }
    | { outcome: 'blocked'; reason: 'held_for_moderation' }
    | { outcome: 'failed'; reason: AlertFailReason; error?: unknown };

/**
 * What a `sendTwitchChatMessage` result says happened. Only a result carrying Twitch's sent message
 * counts as sent: a template that renders to nothing returns `error: false` without sending.
 */
export function chatSendDecision(result: unknown): AlertDecision {
    const value = obj(result);
    if (value.error === true) {
        return value.type === 'held_for_moderation' ? { outcome: 'blocked', reason: 'held_for_moderation' }
            : { outcome: 'failed', reason: 'send_failed', error: str(value.message) || str(value.type) };
    }
    const sent = obj(value.data);
    // A template that is only a reference to another command sends nothing itself: its reply goes out through
    // the nested delivery, which reports how many messages it really sent.
    return sent.is_sent === true || str(sent.message_id) || Number(value.sent) > 0 ? { outcome: 'ok' } : { outcome: 'skipped', reason: 'empty_message' };
}

/**
 * Outcome of a reward's awaited delivery (`deliverAstMessage` / `sendTwitchChatMessage`). It only
 * reports failures, so a delivery without an error is ok whether or not it had text to send.
 */
export function deliveryOutcome(result: unknown): Pick<RedemptionOutcome, 'outcome' | 'reason' | 'error'> {
    const value = obj(result);
    if (value.error !== true) return { outcome: 'ok' };
    if (value.type === 'held_for_moderation') return { outcome: 'blocked', reason: 'held_for_moderation' };
    return { outcome: 'failed', reason: 'send_failed', error: str(value.message) || str(value.type) || 'send failed' };
}

export interface AlertSource {
    /** The Twitch type the alert is for: 'channel.follow', 'channel.bits.use'. */
    type: string;
    channelID: string;
    payload: unknown;
    /** Domain event key for the durable consumer, Twitch message id on the immediate path. */
    ref?: string;
    /** Second message of the same event (the ad-break end message), so it keeps its own row. */
    part?: string;
    /** Who the alert is about when it is not the event's usual viewer (the channel an outgoing raid went to). */
    actor?: Actor | null;
    data?: Record<string, unknown>;
}

export function alertActivity(source: AlertSource, decision: AlertDecision): ActivityInput {
    const ref = source.ref || '';
    const error = decision.outcome === 'failed' && decision.error !== undefined ? { error: errorText(decision.error) } : {};
    return {
        kind: 'alert',
        name: source.type,
        channelID: source.channelID,
        outcome: decision.outcome,
        reason: decision.outcome === 'ok' ? null : decision.reason,
        actor: source.actor !== undefined ? source.actor : eventActor(source.type, source.payload),
        ref,
        // A failed or held attempt has its own key so the consumer's successful retry still writes its row.
        dedupeKey: ref ? `${ref}:alert${source.part ? `:${source.part}` : ''}${decision.outcome === 'failed' || decision.outcome === 'blocked' ? `:${decision.outcome}` : ''}` : null,
        // No text: the alert's message is a template here; the line that was sent is on the bot_message row.
        text: null,
        data: { ...source.data, ...(source.part ? { part: source.part } : {}), ...error }
    };
}

function record(build: () => ActivityInput | null): void {
    try {
        const row = build();
        if (row) recordActivity(row);
    } catch {
        // A debug row must never disturb the event path.
    }
}

export const recordTwitchEvent = (type: string, messageId: string, payload: unknown, condition?: unknown): void =>
    record(() => twitchEventActivity(type, messageId, payload, condition));
export const recordHandlerError = (type: string, channelID: string, ref: string, error: unknown): void =>
    record(() => handlerErrorActivity(type, channelID, ref, error));
export const recordRedemption = (payload: unknown, messageId: string | undefined, result: RedemptionOutcome): void =>
    record(() => redemptionActivity(payload, messageId, result));
export const recordAlert = (source: AlertSource, decision: AlertDecision): void =>
    record(() => alertActivity(source, decision));

/** Twitch revoked a subscription; `status` says why (authorization_revoked, user_removed, …). */
export function revocationActivity(subscription: unknown, channelID?: string): ActivityInput {
    const value = obj(subscription);
    const condition = obj(value.condition);
    const id = str(value.id);
    return {
        kind: 'system',
        name: 'eventsub.revoked',
        channelID: channelID || str(condition.broadcaster_user_id) || str(condition.to_broadcaster_user_id)
            || str(condition.from_broadcaster_user_id) || str(condition.user_id),
        outcome: 'failed',
        reason: str(value.status) || 'revoked',
        ref: id,
        dedupeKey: id ? `revoked:${id}` : null,
        data: { type: str(value.type), subscriptionId: id, version: str(value.version) }
    };
}

export const recordRevocation = (subscription: unknown, channelID?: string): void =>
    record(() => revocationActivity(subscription, channelID));
