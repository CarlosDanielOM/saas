import type { AlertEvent } from './model.js';

export const ALERT_DOMAIN_TYPES: Record<string, AlertEvent> = { 'channel.follow.received': 'follow', 'channel.bits.received': 'bits', 'channel.subscription.received': 'sub', 'channel.subscription.gifted': 'sub', 'channel.raid.received': 'raid' };
/** Twitch can report one resubscription as both channel.subscribe and channel.subscription.message. */
export const SUB_REPEAT_MS = 10 * 60_000;

/**
 * Maps journaled EventSub events to overlay alerts, one alert per viewer action:
 * - a gift shows its gifter's alert; the per-recipient channel.subscribe events are skipped;
 * - a viewer's subscribe + resub message pair shows once.
 */
export class AlertEventFilter {
  private readonly subs = new Map<string, number>();
  kind(channel: string, type: string, event: Record<string, unknown>, at: number): AlertEvent | null {
    const kind = ALERT_DOMAIN_TYPES[type];
    if (!kind || type !== 'channel.subscription.received') return kind ?? null;
    if (event.is_gift === true) return null;
    for (const [key, seen] of this.subs) if (at - seen >= SUB_REPEAT_MS) this.subs.delete(key); else break;
    const user = typeof event.user_id === 'string' && event.user_id ? `${channel}:${event.user_id}` : null;
    if (!user) return kind;
    const previous = this.subs.get(user);
    if (previous !== undefined && Math.abs(at - previous) < SUB_REPEAT_MS) return null;
    this.subs.delete(user); this.subs.set(user, at);
    return kind;
  }
}
