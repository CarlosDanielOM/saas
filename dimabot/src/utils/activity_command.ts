import type { ActivityOutcome } from '../schemas/activity_log.schema.js';
import { recordActivity, type ActivityInput } from './activity_log.js';

/**
 * Activity rows for chat commands and for everything the bot says in chat. The mapping is pure so
 * it can be tested; the `record*` wrappers are what the chat path calls, and they never throw.
 */

export type CommandTrigger = 'chat' | 'keyword' | 'timer' | 'reference';

export const CHAT_MESSAGE_ORIGINS = [
    'command', 'timer', 'alert', 'ai', 'moderation', 'follow_defense', 'redemption', 'system', 'bot'
] as const;
export type ChatMessageOrigin = typeof CHAT_MESSAGE_ORIGINS[number];

export interface ActivityActor { id?: string | null; login?: string | null; name?: string | null }

/** Who a chat message is for and where it came from; only used for the activity log. */
export interface ChatDelivery {
    origin?: ChatMessageOrigin;
    actor?: ActivityActor | null;
}

const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

/** The chatter (or, for other Twitch events, the user) in an event payload; null when there is none. */
export function chatActor(event: unknown): ActivityActor | null {
    if (!event || typeof event !== 'object') return null;
    const source = event as Record<string, unknown>;
    const id = text(source.chatter_user_id) ?? text(source.user_id);
    const login = text(source.chatter_user_login) ?? text(source.user_login);
    const name = text(source.chatter_user_name) ?? text(source.user_name);
    return id || login || name ? { id, login, name } : null;
}

export interface CommandResult { outcome: ActivityOutcome; reason: string | null }

/**
 * Outcome of a command run from the typed result of `commands.handler.ts`. Null means the command
 * does not exist, which is not worth a row.
 */
export function commandResultOutcome(type: string | null | undefined, failed: boolean): CommandResult | null {
    if (!failed) return { outcome: 'ok', reason: null };
    switch (type) {
        case 'command_not_found': return null;
        case 'command_cooldown': return { outcome: 'skipped', reason: 'cooldown' };
        case 'command_disabled': return { outcome: 'skipped', reason: 'disabled' };
        case 'permission_denied': return { outcome: 'blocked', reason: 'permission_denied' };
        default: return { outcome: 'failed', reason: type || 'error' };
    }
}

export interface CommandAttempt extends CommandResult {
    channelID: string;
    /** As typed in chat ('!so'), the keyword, or the timer name. */
    name: string;
    trigger: CommandTrigger;
    func?: string | null;
    /** The chat event that asked for it; gives the actor, the chat line and the message id. */
    event?: unknown;
    durationMs?: number | null;
    /** Distinguishes two rows for the same chat message (a keyword id, a reference depth). */
    key?: string | null;
    data?: Record<string, string | number | boolean | null>;
}

export function commandActivity(attempt: CommandAttempt): ActivityInput {
    const event = attempt.event && typeof attempt.event === 'object' ? attempt.event as Record<string, unknown> : null;
    const message = event?.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : null;
    const messageID = text(event?.message_id);
    return {
        kind: 'command',
        name: attempt.name,
        channelID: attempt.channelID,
        outcome: attempt.outcome,
        reason: attempt.reason,
        actor: chatActor(event),
        text: text(message?.text),
        ref: messageID,
        durationMs: attempt.durationMs ?? null,
        // Twitch retries a delivery with the same message id: one row per message and command.
        dedupeKey: messageID ? `${messageID}:${attempt.trigger}:${attempt.key ?? attempt.name.toLowerCase()}` : null,
        data: { ...attempt.data, func: attempt.func || undefined, trigger: attempt.trigger }
    };
}

export function recordCommandActivity(attempt: CommandAttempt): void {
    try { recordActivity(commandActivity(attempt)); } catch { /* a debug row must never break a command */ }
}

export type ChatSendResult =
    | { status: 'sent'; messageId?: string | null }
    | { status: 'held'; messageId?: string | null; twitchMessage?: string | null }
    | { status: 'rejected'; httpStatus: number; twitchMessage?: string | null }
    | { status: 'no_token' }
    | { status: 'exception' };

export interface BotMessageAttempt {
    channelID: string;
    text: string;
    replyTo?: string | null;
    delivery?: ChatDelivery | null;
    result: ChatSendResult;
    durationMs?: number | null;
}

export function chatOrigin(origin: unknown): ChatMessageOrigin {
    return CHAT_MESSAGE_ORIGINS.includes(origin as ChatMessageOrigin) ? origin as ChatMessageOrigin : 'bot';
}

export function botMessageActivity(attempt: BotMessageAttempt): ActivityInput {
    const origin = chatOrigin(attempt.delivery?.origin);
    const result = attempt.result;
    const messageId = 'messageId' in result ? result.messageId || null : null;
    const outcome: CommandResult = result.status === 'sent' ? { outcome: 'ok', reason: null }
        : result.status === 'held' ? { outcome: 'blocked', reason: 'held_for_moderation' }
        : result.status === 'rejected' ? { outcome: 'failed', reason: 'twitch_rejected' }
        : { outcome: 'failed', reason: result.status };
    return {
        kind: 'bot_message',
        name: origin,
        channelID: attempt.channelID,
        ...outcome,
        actor: attempt.delivery?.actor ?? null,
        text: typeof attempt.text === 'string' ? attempt.text : null,
        ref: messageId,
        durationMs: attempt.durationMs ?? null,
        data: {
            origin,
            // Absent facts stay out of the row instead of being stored as nulls.
            messageId: messageId ?? undefined,
            replyTo: attempt.replyTo || undefined,
            httpStatus: result.status === 'rejected' ? result.httpStatus : undefined,
            twitchMessage: 'twitchMessage' in result ? result.twitchMessage || undefined : undefined
        }
    };
}

export function recordBotMessage(attempt: BotMessageAttempt): void {
    try { recordActivity(botMessageActivity(attempt)); } catch { /* a debug row must never break a send */ }
}
