/**
 * Hype trains and ad breaks for custom widgets (`uses`: hypetrain, ads). Public data only: Twitch shows hype train top
 * contributors publicly; the ad requester and raw payloads are never kept. Stored like polls (overlay_interactions).
 */
export const HYPE_TRAIN_EVENT_TYPES = {
  'channel.hype_train.begin': 'channel.hype_train.began', 'channel.hype_train.progress': 'channel.hype_train.updated', 'channel.hype_train.end': 'channel.hype_train.ended'
} as const;
export const AD_BREAK_EVENT_TYPES = { 'channel.ad_break.begin': 'channel.ad_break.began' } as const;
export const LIVE_EVENT_DOMAIN_TYPES = [...Object.values(HYPE_TRAIN_EVENT_TYPES), ...Object.values(AD_BREAK_EVENT_TYPES)];

export interface HypeUser { id: string; login: string; name: string }
export interface HypeContribution { user: HypeUser; type: 'bits' | 'subscription' | 'other'; total: number }
export interface HypeTrain {
  id: string; phase: 'active' | 'ended'; level: number; total: number; progress: number | null; goal: number | null;
  topContributions: HypeContribution[]; allTimeHigh: { level: number; total: number } | null;
  type: 'regular' | 'golden_kappa' | 'treasure'; shared: boolean; sharedParticipants: HypeUser[];
  startedAt: string; expiresAt: string | null; endedAt: string | null; cooldownEndsAt: string | null;
}
/** Stored document: the train (or null once Twitch confirmed none is running) plus what orders later updates. */
export interface StoredHypeTrain {
  train: HypeTrain | null; occurredAt: string; receipts: string[];
  /** Set when Helix confirmed no train: updates that happened before then (or older trains) can't bring it back. */
  cleared: { id: string; startedAt: string; at: string } | null;
}
export interface AdBreak { startedAt: string; duration: number; automatic: boolean }
export interface StoredAdBreak { ad: AdBreak; occurredAt: string; receipts: string[] }

const fail = (message: string): never => { throw new Error(message); };
function text(value: unknown, max = 200): string {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : fail('Invalid live event text');
}
function time(value: unknown): string {
  const result = text(value, 40);
  return /^\d{4}-\d{2}-\d{2}T/.test(result) && Number.isFinite(Date.parse(result)) ? result : fail('Invalid live event timestamp');
}
const optionalTime = (value: unknown) => value === undefined || value === null || value === '' ? null : time(value);
/** Twitch examples quote numbers ("60"): accept integers and integer strings. */
function count(value: unknown): number {
  const result = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : fail('Invalid live event count');
}
const optionalCount = (value: unknown) => value === undefined || value === null || value === '' ? null : count(value);
const flag = (value: unknown) => value === true || value === 'true';
/** Contributors and shared-train channels; an entry without an id or login is skipped (never rejects the event). */
function user(raw: unknown, prefix: 'user' | 'broadcaster_user'): HypeUser | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const id = record[`${prefix}_id`], login = record[`${prefix}_login`], name = record[`${prefix}_name`];
  if (typeof id !== 'string' || !id || id.length > 64 || typeof login !== 'string' || !login || login.length > 64) return null;
  return { id, login, name: typeof name === 'string' && name ? name.slice(0, 64) : login };
}
const list = (raw: unknown): unknown[] => raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];

/**
 * One EventSub hype train notification (v2), or Helix `current` (the begin/progress shape) as a progress update. Only the
 * train id, level, total and start are required; the rest is optional so an unexpected detail can't reject the event.
 */
export function parseHypeTrain(type: string, event: Record<string, unknown>, occurredAt: string): HypeTrain {
  if (!Object.hasOwn(HYPE_TRAIN_EVENT_TYPES, type)) fail('Invalid hype train event');
  const ended = type === 'channel.hype_train.end';
  const contributions: HypeContribution[] = [];
  for (const raw of list(event.top_contributions).slice(0, 10)) {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, who = user(record, 'user'), total = optionalCount(record.total);
    if (who && total !== null) contributions.push({ user: who, type: record.type === 'bits' || record.type === 'subscription' ? record.type : 'other', total });
  }
  const trainType = String(event.type), high = optionalCount(event.all_time_high_level);
  return {
    id: text(event.id, 100), phase: ended ? 'ended' : 'active', level: Math.max(1, count(event.level)), total: count(event.total),
    progress: ended ? null : optionalCount(event.progress), goal: ended ? null : optionalCount(event.goal), topContributions: contributions,
    allTimeHigh: high === null ? null : { level: high, total: optionalCount(event.all_time_high_total) ?? 0 },
    type: trainType === 'golden_kappa' || trainType === 'treasure' ? trainType : 'regular', shared: flag(event.is_shared_train),
    sharedParticipants: list(event.shared_train_participants).slice(0, 10).map(raw => user(raw, 'broadcaster_user')).filter((who): who is HypeUser => !!who),
    startedAt: time(event.started_at), expiresAt: ended ? null : optionalTime(event.expires_at),
    endedAt: ended ? optionalTime(event.ended_at) ?? time(occurredAt) : null, cooldownEndsAt: ended ? optionalTime(event.cooldown_ends_at) : null
  };
}

const RECEIPTS = 20;
const after = (a: string, b: string) => Date.parse(a) > Date.parse(b);
/**
 * Ordering: a newer train (later start) replaces an older one; for the same train an end always wins and never goes back
 * to active; while active, totals and levels only go up (EventSub timestamps are only millisecond-precise). Values an
 * update lacks (all-time high on progress/end, progress/goal on end) are kept from what was known.
 */
export function reduceHypeTrain(current: StoredHypeTrain | null, next: HypeTrain, occurredAt: string, receipt: string): StoredHypeTrain | null {
  if (current?.receipts.includes(receipt)) return null;
  const old = current?.train ?? null, receipts = [receipt, ...(current?.receipts ?? [])].slice(0, RECEIPTS);
  const cleared = current?.cleared;
  if (cleared && cleared.id === next.id && next.phase === 'active' && !after(occurredAt, cleared.at)) return null;
  if (cleared && !old && cleared.id !== next.id && !after(next.startedAt, cleared.startedAt)) return null;
  if (old && old.id !== next.id) {
    if (!after(next.startedAt, old.startedAt)) return null;
    return { train: next, occurredAt, receipts, cleared: null };
  }
  if (old && old.id === next.id) {
    if (old.phase === 'ended' && next.phase === 'active') return null;
    if (old.phase === 'active' && next.phase === 'active' && (next.total < old.total || next.total === old.total && !after(occurredAt, current!.occurredAt))) return null;
    if (old.phase === 'ended' && next.phase === 'ended') return null;
    next = { ...next, level: Math.max(old.level, next.level), allTimeHigh: next.allTimeHigh ?? old.allTimeHigh,
      ...(next.phase === 'ended' ? { total: Math.max(old.total, next.total) } : {}) };
  }
  return { train: next, occurredAt, receipts, cleared: null };
}
/** Helix said no train is running: clear an active one (the watermark keeps earlier updates from bringing it back). */
export function clearHypeTrain(current: StoredHypeTrain | null, at: string): StoredHypeTrain | null {
  if (!current?.train || current.train.phase !== 'active') return null;
  return { ...current, train: null, cleared: { id: current.train.id, startedAt: current.train.startedAt, at } };
}
const ENDED_VISIBLE_MS = 2 * 3_600_000;
/** What widgets see: an ended train stays until its cooldown ends (2 hours at most), then null. */
export function publicHypeTrain(stored: StoredHypeTrain | null, now: number): Record<string, unknown> | null {
  const train = stored?.train;
  if (!train) return null;
  if (train.phase === 'ended') {
    const ended = Date.parse(train.endedAt!), cooldown = train.cooldownEndsAt ? Date.parse(train.cooldownEndsAt) : ended;
    if (now >= Math.min(Math.max(cooldown, ended), ended + ENDED_VISIBLE_MS)) return null;
  }
  const ms = (value: string | null) => value === null ? null : Date.parse(value);
  return { id: train.id, phase: train.phase, level: train.level, total: train.total, progress: train.progress, goal: train.goal,
    topContributions: train.topContributions, allTimeHigh: train.allTimeHigh, type: train.type, shared: train.shared,
    sharedParticipants: train.sharedParticipants, startedAt: ms(train.startedAt), expiresAt: ms(train.expiresAt),
    endedAt: ms(train.endedAt), cooldownEndsAt: ms(train.cooldownEndsAt) };
}
/** An active train past its end time with no end event: ask Twitch (the caller coalesces). */
export const hypeTrainOverdue = (stored: StoredHypeTrain | null, now: number) =>
  stored?.train?.phase === 'active' && !!stored.train.expiresAt && Date.parse(stored.train.expiresAt) + 10_000 < now;

export function parseAdBreak(event: Record<string, unknown>): AdBreak {
  return { startedAt: time(event.started_at), duration: Math.min(count(event.duration_seconds), 600), automatic: flag(event.is_automatic) };
}
/** A later break replaces an earlier one; a delayed older notification never does. */
export function reduceAdBreak(current: StoredAdBreak | null, next: AdBreak, occurredAt: string, receipt: string): StoredAdBreak | null {
  if (current?.receipts.includes(receipt)) return null;
  if (current && !after(next.startedAt, current.ad.startedAt)) return null;
  return { ad: next, occurredAt, receipts: [receipt, ...(current?.receipts ?? [])].slice(0, RECEIPTS) };
}
/** Helix ad schedule as fetched (times in ms; `prerollFreeUntil` from the remaining seconds at fetch time). */
export interface AdSchedule { nextAt: number | null; duration: number | null; lastAt: number | null; snoozes: number | null; snoozeRefreshAt: number | null; prerollFreeUntil: number | null }
export function parseAdSchedule(raw: Record<string, unknown> | undefined, fetchedAt: number): AdSchedule | null {
  if (!raw) return null;
  const at = (value: unknown) => { const result = optionalTime(value); return result === null ? null : Date.parse(result); };
  const preroll = optionalCount(raw.preroll_free_time);
  return { nextAt: at(raw.next_ad_at), duration: optionalCount(raw.duration), lastAt: at(raw.last_ad_at), snoozes: optionalCount(raw.snooze_count),
    snoozeRefreshAt: at(raw.snooze_refresh_at), prerollFreeUntil: preroll ? fetchedAt + preroll * 1000 : null };
}
/** What widgets see: the running break (computed against now, so its end needs no timer) and the schedule when known. */
export function publicAds(stored: StoredAdBreak | null, schedule: AdSchedule | null, now: number): Record<string, unknown> {
  const ad = stored?.ad, startedAt = ad ? Date.parse(ad.startedAt) : 0, endsAt = ad ? startedAt + ad.duration * 1000 : 0;
  return { active: ad && now < endsAt ? { startedAt, endsAt, duration: ad.duration, automatic: ad.automatic } : null, schedule };
}
