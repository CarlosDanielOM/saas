import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { FollowRelationshipLedgerSchema } from '../schemas/follow_relationship_ledger.schema.js';
import { StreamSubscriptionLedgerSchema } from '../schemas/stream_subscription_ledger.schema.js';
import { channelGoals } from './state.js';
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
/** The event journal keeps channel events 90 days: "total" Bits and raids mean what we still have. */
const RETAINED_MS = 90 * DAY_MS;
interface Totals { follows: number; subs: number; bits: number; raids: number }
type Range = 'session' | 'week' | 'month' | 'retained';
/**
 * Counts in the journal for several ranges in one pass (no event limit). Subscribers count each viewer once plus
 * gifted subs.
 */
async function totals(channel: string, ranges: Record<Range, Date>): Promise<Record<Range, Totals>> {
  const earliest = new Date(Math.min(...Object.values(ranges).map(date => date.getTime())));
  const when = (from: Date, type: string, ...more: unknown[]) => ({ $and: [{ $gte: ['$occurredAt', from] }, { $eq: ['$type', type] }, ...more] });
  const group: Record<string, unknown> = { _id: null };
  for (const [range, from] of Object.entries(ranges)) {
    group[range + 'Follows'] = { $sum: { $cond: [when(from, 'channel.follow.received'), 1, 0] } };
    group[range + 'Subs'] = { $addToSet: { $cond: [when(from, 'channel.subscription.received', { $ne: ['$payload.event.is_gift', true] }), '$payload.event.user_id', null] } };
    group[range + 'Gifts'] = { $sum: { $cond: [when(from, 'channel.subscription.gifted'), { $ifNull: ['$payload.event.total', 1] }, 0] } };
    group[range + 'Bits'] = { $sum: { $cond: [when(from, 'channel.bits.received'), { $ifNull: ['$payload.event.bits', 0] }, 0] } };
    group[range + 'Raids'] = { $sum: { $cond: [when(from, 'channel.raid.received'), 1, 0] } };
  }
  const [row] = await DomainEventSchema.aggregate<Record<string, unknown>>([
    { $match: { channelID: channel, source: 'twitch-eventsub', type: { $in: Object.keys(ALERT_DOMAIN_TYPES) }, occurredAt: { $gte: earliest } } },
    { $group: group as never }
  ]);
  const n = (key: string) => Number(row?.[key]) || 0;
  const subs = (key: string) => (Array.isArray(row?.[key]) ? (row[key] as unknown[]).filter(id => id !== null && id !== undefined) : []).length;
  return Object.fromEntries(Object.keys(ranges).map(range => [range, {
    follows: n(range + 'Follows'), subs: subs(range + 'Subs') + n(range + 'Gifts'), bits: n(range + 'Bits'), raids: n(range + 'Raids')
  }])) as Record<Range, Totals>;
}

const GOAL_PREFIX = { follows: 'follower', subs: 'subscriber', bits: 'cheer', currency: 'tip' } as const;
interface GoalProgress { id: string; name: string; metric: string; status: string; current: number }
/**
 * StreamElements' "manual" goals (`follower-goal`, `subscriber-goal`, `cheer-goal`, `tip-goal`) follow the streamer's
 * Goals page: per metric, the first active goal in their list, else the first reached one. Currency goals are stored in
 * cents.
 */
export function seGoals(goals: readonly GoalProgress[]): { data: Record<string, { amount: number }>; sources: Record<string, { id: string; name: string; status: string }> } {
  const data: Record<string, { amount: number }> = {}, sources: Record<string, { id: string; name: string; status: string }> = {};
  for (const [metric, prefix] of Object.entries(GOAL_PREFIX)) {
    const goal = goals.find(item => item.metric === metric && item.status === 'active') ?? goals.find(item => item.metric === metric && item.status === 'reached');
    if (!goal) continue;
    data[prefix + '-goal'] = { amount: metric === 'currency' ? goal.current / 100 : goal.current };
    sources[prefix + '-goal'] = { id: goal.id, name: goal.name, status: goal.status };
  }
  return { data, sources };
}
/**
 * Session snapshot: latest and recent alerts from the channel's event journal (newest 500 in the last 7 days, through
 * the same filter as live alerts); counts for the current stream (since the latest stream start, else the last 24 h),
 * the week and the UTC calendar month; totals = current followers and subscribers (ledgers), Bits and raids over the
 * journal's 90 days; `*-goal` from the streamer's Goals page (see seGoals). Tips stay empty until our tipping ships.
 * `goalSources` (Studio only) names the goal behind each `*-goal`.
 */
type SessionSnapshot = DimaSession & { goalSources?: Record<string, { id: string; name: string; status: string }> };
const inflight = new Map<string, Promise<SessionSnapshot>>();
export function sessionFor(channel: string, now = Date.now(), goalSources = false): Promise<SessionSnapshot> {
  // OBS sources reconnecting together (e.g. after a deploy) share one query per channel.
  const key = channel + (goalSources ? ':studio' : '');
  let pending = inflight.get(key);
  if (!pending) {
    pending = buildSession(channel, now, goalSources).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * The follower ledger is a periodic full sync from Twitch: follows journaled after its last change are added, so
 * "total" moves with live follows. The cursor (newest ledger change) is re-read every 2 minutes or when the count moved.
 */
const ledgerCursors = new Map<string, { at: number; active: number; cursor: Date | null }>();
async function followerTotal(channel: string, now: number): Promise<number> {
  const active = await FollowRelationshipLedgerSchema.countDocuments({ platform: 'twitch', followed_id: channel, status: 'active' });
  let cached = ledgerCursors.get(channel);
  if (!cached || cached.active !== active || now - cached.at > 120_000) {
    const newest = await FollowRelationshipLedgerSchema.findOne({ platform: 'twitch', followed_id: channel }).sort({ updated_at: -1 }).select('updated_at').lean() as { updated_at?: Date } | null;
    cached = { at: now, active, cursor: newest?.updated_at ? new Date(newest.updated_at) : null };
    ledgerCursors.delete(channel); ledgerCursors.set(channel, cached);
    if (ledgerCursors.size > 5000) ledgerCursors.delete(ledgerCursors.keys().next().value!);
  }
  const since = await DomainEventSchema.countDocuments({ channelID: channel, source: 'twitch-eventsub', type: 'channel.follow.received',
    ...(cached.cursor ? { occurredAt: { $gt: cached.cursor } } : {}) });
  return active + since;
}

async function buildSession(channel: string, now: number, goalSources: boolean): Promise<SessionSnapshot> {
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
  const today = new Date(now), monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const [counts, followers, subscribers, goals] = await Promise.all([
    totals(channel, { session: sessionStart, week: weekStart, month: monthStart, retained: new Date(now - RETAINED_MS) }),
    // Totals like StreamElements': current followers and subscribers (the same ledgers the dashboard and Goals use).
    followerTotal(channel, now),
    StreamSubscriptionLedgerSchema.countDocuments({ platform: 'twitch', streamer_id: channel, status: 'active' }),
    channelGoals(channel, now).then(goals => goals as GoalProgress[]).catch(() => [] as GoalProgress[])
  ]);
  for (const span of ['session', 'week', 'month'] as const) {
    data[`follower-${span}`] = { count: counts[span].follows };
    data[`subscriber-${span}`] = { count: counts[span].subs };
    data[`cheer-${span}`] = { amount: counts[span].bits };
    data[`raid-${span}`] = { count: counts[span].raids };
  }
  data['follower-total'] = { count: followers };
  data['subscriber-total'] = { count: subscribers };
  data['cheer-total'] = { amount: counts.retained.bits };
  data['raid-total'] = { count: counts.retained.raids };
  const manual = seGoals(goals);
  Object.assign(data, manual.data);
  return goalSources ? Object.assign(session, { goalSources: manual.sources }) : session;
}
