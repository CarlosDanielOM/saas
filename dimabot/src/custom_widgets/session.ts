import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { ALERT_DOMAIN_TYPES, AlertEventFilter } from '../overlays/alert-events.js';

/** Dima SDK v1 alert (CUSTOM_WIDGET_ENGINE.md, section 4). */
export interface DimaUser { id: string; login: string; name: string }
export interface DimaAlert {
  id: string; type: 'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid' | 'tip'; at: number; test: boolean;
  user: DimaUser | null; amount: number;
  tier: '1000' | '2000' | '3000' | 'prime' | null; months: number | null; streak: number | null;
  message: string | null; recipient: DimaUser | null; currency: string | null; rule: { id: string; name: string } | null;
}
export interface DimaSession { data: Record<string, unknown>; recents: unknown[] }

const text = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const int = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
const user = (raw: Record<string, unknown>, prefix = 'user_'): DimaUser | null => {
  const id = text(raw[prefix + 'id'], 64), login = text(raw[prefix + 'login'], 64), name = text(raw[prefix + 'name'], 64);
  return id || login || name ? { id, login: login || name.toLowerCase(), name: name || login } : null;
};
const tier = (value: unknown): DimaAlert['tier'] => value === '1000' || value === '2000' || value === '3000' ? value : value === 'prime' || value === 'Prime' ? 'prime' : null;
const messageText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.slice(0, 500) || null;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text.slice(0, 500) || null;
  return null;
};

/**
 * Twitch EventSub alert → Dima alert. `subscriptionType` is the original EventSub type (kept in the journal
 * payload), which tells new subs, resubs and gifts apart.
 */
export function alertFromEventsub(subscriptionType: string, raw: Record<string, unknown>, id: string, at: number, test = false, rule: DimaAlert['rule'] = null): DimaAlert | null {
  const base: DimaAlert = { id, type: 'follow', at, test, user: user(raw), amount: 1, tier: null, months: null, streak: null, message: null, recipient: null, currency: null, rule: null };
  switch (subscriptionType) {
    case 'channel.follow': return base;
    case 'channel.subscribe':
      if (raw['is_gift'] === true) return null;
      return { ...base, type: 'sub', tier: tier(raw['tier']), months: 1, amount: 1 };
    case 'channel.subscription.message': {
      const months = int(raw['cumulative_months']) || 1;
      return { ...base, type: months > 1 ? 'resub' : 'sub', tier: tier(raw['tier']), months, amount: months, streak: int(raw['streak_months']) || null, message: messageText(raw['message']) };
    }
    case 'channel.subscription.gift':
      return { ...base, type: 'gift', user: raw['is_anonymous'] === true ? null : base.user, tier: tier(raw['tier']), amount: int(raw['total']) || 1 };
    case 'channel.bits.use': case 'channel.bit.use': case 'channel.cheer':
      return { ...base, type: 'bits', user: raw['is_anonymous'] === true ? null : base.user, amount: int(raw['bits']), message: messageText(raw['message']), rule };
    case 'channel.raid':
      return { ...base, type: 'raid', user: user(raw, 'from_broadcaster_user_'), amount: int(raw['viewers']) };
    default: return null;
  }
}

const PREFIX: Record<DimaAlert['type'], string> = { follow: 'follower', sub: 'subscriber', resub: 'subscriber', gift: 'subscriber', bits: 'cheer', raid: 'raid', tip: 'tip' };
/** StreamElements-shaped entry used in `*-latest` / `*-recent` (same shape the SE layer builds from live alerts). */
export function seSessionEntry(alert: DimaAlert): Record<string, unknown> {
  const name = alert.user?.name ?? 'Anonymous';
  const entry: Record<string, unknown> = { type: PREFIX[alert.type], name, amount: alert.amount, message: alert.message ?? '', createdAt: new Date(alert.at).toISOString(), _id: alert.id };
  if (alert.type === 'sub' || alert.type === 'resub') Object.assign(entry, { tier: alert.tier ?? '1000', gifted: false });
  if (alert.type === 'gift') Object.assign(entry, { tier: alert.tier ?? '1000', gifted: true, sender: name, bulkGifted: true });
  return entry;
}
function emptySession(): DimaSession {
  const data: Record<string, unknown> = {};
  for (const prefix of ['follower', 'subscriber', 'cheer', 'raid', 'tip']) {
    data[prefix + '-latest'] = { name: '', amount: 0 };
    data[prefix + '-recent'] = [];
    for (const span of ['session', 'week', 'month', 'total']) data[`${prefix}-${span}`] = prefix === 'cheer' || prefix === 'tip' ? { amount: 0 } : { count: 0 };
    data[prefix + '-goal'] = { amount: 0 };
  }
  data['subscriber-new-latest'] = { name: '', amount: 0 };
  data['subscriber-resub-latest'] = { name: '', amount: 0 };
  data['subscriber-gifted-latest'] = { name: '', amount: 0, sender: '' };
  return { data, recents: [] };
}

const WEEK_MS = 7 * 24 * 3600_000, DAY_MS = 24 * 3600_000, RECENT_SCAN = 500;
interface Totals { follows: number; subs: number; bits: number; raids: number }
/** Counts in the database across the whole range (no event limit). Subscribers count each viewer once plus gifted subs. */
async function totals(channel: string, from: Date): Promise<Totals> {
  const [row] = await DomainEventSchema.aggregate<{ follows: { n: number }[]; subs: { n: number }[]; gifts: { n: number }[]; bits: { n: number }[]; raids: { n: number }[] }>([
    { $match: { channelID: channel, source: 'twitch-eventsub', type: { $in: Object.keys(ALERT_DOMAIN_TYPES) }, occurredAt: { $gte: from } } },
    { $facet: {
      follows: [{ $match: { type: 'channel.follow.received' } }, { $count: 'n' }],
      subs: [{ $match: { type: 'channel.subscription.received', 'payload.event.is_gift': { $ne: true } } }, { $group: { _id: '$payload.event.user_id' } }, { $count: 'n' }],
      gifts: [{ $match: { type: 'channel.subscription.gifted' } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$payload.event.total', 1] } } } }],
      bits: [{ $match: { type: 'channel.bits.received' } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$payload.event.bits', 0] } } } }],
      raids: [{ $match: { type: 'channel.raid.received' } }, { $count: 'n' }]
    } }
  ]);
  const n = (list?: { n: number }[]) => Number(list?.[0]?.n) || 0;
  return { follows: n(row?.follows), subs: n(row?.subs) + n(row?.gifts), bits: n(row?.bits), raids: n(row?.raids) };
}
/**
 * Session snapshot from the channel's event journal: latest and recent alerts (newest 500 in the last 7 days, through
 * the same filter as live alerts), and counts for the current stream (since the latest stream start, else the last
 * 24 h) and the week, counted across the whole range. Monthly/total figures and goals aren't tracked here and stay 0;
 * tips stay empty until our tipping feature ships.
 */
export async function sessionFor(channel: string, now = Date.now()): Promise<DimaSession> {
  const session = emptySession(), data = session.data, weekStart = new Date(now - WEEK_MS);
  const [started] = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', type: 'stream.started', occurredAt: { $gte: weekStart } })
    .sort({ occurredAt: -1 }).limit(1).select('occurredAt').lean();
  const sessionStart = started ? new Date(started.occurredAt) : new Date(now - DAY_MS);
  const recent = await DomainEventSchema.find({ channelID: channel, source: 'twitch-eventsub', type: { $in: Object.keys(ALERT_DOMAIN_TYPES) }, occurredAt: { $gte: weekStart } })
    .sort({ occurredAt: -1, _id: -1 }).limit(RECENT_SCAN).select('type occurredAt payload').lean();
  const filter = new AlertEventFilter();
  for (const event of recent.reverse()) {
    const payload = event.payload as { subscription?: { type?: string }; event?: Record<string, unknown> };
    const raw = payload?.event ?? {}, at = new Date(event.occurredAt).getTime();
    if (!filter.kind(channel, event.type, raw, at)) continue;
    const alert = alertFromEventsub(String(payload?.subscription?.type ?? ''), raw, String(event._id), at);
    if (!alert) continue;
    const prefix = PREFIX[alert.type], entry = seSessionEntry(alert);
    data[prefix + '-latest'] = entry;
    if (alert.type === 'sub') data['subscriber-new-latest'] = entry;
    if (alert.type === 'resub') data['subscriber-resub-latest'] = entry;
    if (alert.type === 'gift') data['subscriber-gifted-latest'] = entry;
    data[prefix + '-recent'] = [entry, ...(data[prefix + '-recent'] as unknown[])].slice(0, 25);
    session.recents = [entry, ...session.recents].slice(0, 25);
  }
  const [week, current] = await Promise.all([totals(channel, weekStart), totals(channel, sessionStart)]);
  for (const [span, value] of [['week', week], ['session', current]] as const) {
    data[`follower-${span}`] = { count: value.follows };
    data[`subscriber-${span}`] = { count: value.subs };
    data[`cheer-${span}`] = { amount: value.bits };
    data[`raid-${span}`] = { count: value.raids };
  }
  return session;
}
