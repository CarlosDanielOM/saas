/**
 * Overlay Studio alerts: Twitch follows, subs/gifts, Bits and raids read from the domain event log while a source is
 * open, one alert per viewer action, matched against the shared Bits rules.
 */
import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { matchBitsRule, type BitsRule } from '../../bits_rules/model.js';
import { loadBitsRules } from '../../bits_rules/store.js';
import { ALERT_DOMAIN_TYPES, AlertEventFilter } from '../alert-events.js';
import { deliveries, DELIVERY_TTL_MS } from '../delivery-store.js';
import { DomainEventSchema } from '../../schemas/domain_event.schema.js';
import type { OverlayPlatform } from '../controls.js';
import type { AlertEvent, EventKind } from '../model.js';
import { recipients, restore } from './connections.live.js';
import { deliver, pending } from './delivery.live.js';
import { feedAlert } from './widget_feeds.live.js';

export interface AlertCursor { after: Types.ObjectId; busy: boolean }
/** Read position in the event log, per channel with an open source. */
export const channels = new Map<string, AlertCursor>();
const alertFilter = new AlertEventFilter();
/** The shared Bits rule a cheer matches (null for other events or when no rule matches). */
export async function bitsRuleFor(channel: string, kind: EventKind, raw?: Record<string, unknown>): Promise<BitsRule | null> {
  return kind === 'bits' && raw ? matchBitsRule((await loadBitsRules(channel)).rules, raw.bits) : null;
}
export async function publishStudioAlert(channel: string, kind: AlertEvent, raw: Record<string, unknown>, sourceId: string = randomUUID(), since = Date.now(), platform: OverlayPlatform = 'twitch', retainDisconnected = false): Promise<number> {
  await restore();
  // A Bits rule can keep certain amounts chat-only.
  if (kind === 'bits' && (await bitsRuleFor(channel, kind, raw))?.alert === false) return 0;
  const selected = recipients(channel, kind, retainDisconnected).filter(p => p.since <= since); if (!selected.length) return 0;
  // Journal alerts retain recipients during their reconnect lease; manual tests still require a live source.
  // Provider receipt IDs protect clients against duplicate poll delivery.
  const id = `alert-${sourceId}`; if (pending.has(id) || await (await deliveries()).findOne({ _id: id })) return 0;
  await deliver({ channel, expiresAt: new Date(Date.now() + DELIVERY_TTL_MS), event: { id, kind, platform }, raw, recipients: new Set(selected.map(p => p.key)) }, selected);
  return selected.length;
}
/** New Twitch events of one channel from the event log: Studio alerts, and Dima alerts for custom widgets. */
export async function pollChannelAlerts(channel: string, cursor: AlertCursor): Promise<void> {
  if (cursor.busy) return; cursor.busy = true;
  try {
    const events = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', schemaVersion: 1, _id: { $gt: cursor.after }, type: { $in: Object.keys(ALERT_DOMAIN_TYPES) } }).sort({ _id: 1 }).limit(100).lean();
    for (const event of events) {
      const raw = event.payload.event as Record<string, unknown>, kind = alertFilter.kind(channel, event.type, raw, event.journaledAt.getTime());
      if (kind) await publishStudioAlert(channel, kind, raw, String(event._id), event.journaledAt.getTime(), 'twitch', true);
      if (kind) await feedAlert(channel, String((event.payload as { subscription?: { type?: unknown } })?.subscription?.type ?? ''), raw, String(event._id), event.journaledAt.getTime()).catch(() => {});
      cursor.after = event._id;
    }
  } finally { cursor.busy = false; }
}
