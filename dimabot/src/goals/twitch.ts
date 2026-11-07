/**
 * Twitch Creator Goals: goals the streamer makes on Twitch (Helix `GET /goals`, EventSub `channel.goal.*`). Read-only
 * (Twitch has no API to create or edit them), free on every plan and outside the goal quota. Stored like hype trains,
 * in `overlay_interactions` as `channel:twitchgoals` (see twitch-store.ts). Pure model here: parsing, ordering, views.
 */
export const TWITCH_GOAL_TYPES = ['follow', 'subscription', 'subscription_count', 'new_subscription', 'new_subscription_count', 'new_bit', 'new_cheerer'] as const;
export type TwitchGoalType = typeof TWITCH_GOAL_TYPES[number];
export const TWITCH_GOAL_EVENT_TYPES = {
  'channel.goal.begin': 'channel.goal.began', 'channel.goal.progress': 'channel.goal.updated', 'channel.goal.end': 'channel.goal.ended'
} as const;
/** Actions on Twitch Bits and cheerer goals need Premium, like our own Bits goals. Seeing them is free. */
export const PREMIUM_TWITCH_GOAL_TYPES: readonly TwitchGoalType[] = ['new_bit', 'new_cheerer'];
export const twitchGoalTypesFor = (plan: 'free' | 'premium' | 'pro'): TwitchGoalType[] =>
  TWITCH_GOAL_TYPES.filter(type => plan !== 'free' || !PREMIUM_TWITCH_GOAL_TYPES.includes(type));
export const isTwitchGoalType = (value: unknown): value is TwitchGoalType => TWITCH_GOAL_TYPES.includes(value as TwitchGoalType);

export interface TwitchGoalObservation {
  id: string; type: TwitchGoalType; description: string; current: number; target: number; startedAt: string;
  /** Only `end`: Twitch's own verdict and end time. */
  achieved: boolean | null; endedAt: string | null;
  kind: 'begin' | 'progress' | 'end';
}
export interface TwitchGoal {
  id: string; type: TwitchGoalType; description: string; current: number; target: number; startedAt: string;
  /** `missing`: Helix stopped listing it but no end event came (may come back); `ended`: Twitch's end event (final). */
  phase: 'active' | 'missing' | 'ended';
  achieved: boolean | null; endedAt: string | null;
  /** Newest EventSub event applied (orders events among themselves). */
  eventAt: string | null;
  /** Newest Helix read that listed it. */
  seenAt: string | null;
  missingSince: string | null;
  /** Ever known to be below its target (an event or a Helix read). */
  seenBelow: boolean;
  /** First Helix read that found it at or past its target before any event showed the crossing. */
  aboveSeenAt: string | null;
  /**
   * First time it was known to be at or past its target. `event`: a Twitch event showed it crossing (actions may run);
   * `baseline`: first seen already there, or the crossing was missed (time unknown, actions never run for it).
   */
  reachedAt: string | null; reachedBy: 'event' | 'baseline' | null;
}
export interface StoredTwitchGoals {
  goals: TwitchGoal[]; receipts: string[];
  /** Result of the last Helix read: `permission` when the streamer hasn't granted `channel:read:goals`. */
  access: 'ok' | 'permission' | null; checkedAt: string | null;
}

const fail = (message: string): never => { throw new Error(message); };
/** Twitch examples quote numbers ("400"): integers and integer strings. */
function count(value: unknown): number {
  const result = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : fail('Invalid Twitch goal amount');
}
function time(value: unknown): string {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail('Invalid Twitch goal time');
}
/** Goal ids become Mongo path segments (`outcomes.twitch:<id>`): letters, digits, `-` and `_` only. */
export function twitchGoalId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : fail('Invalid Twitch goal id');
}
/** EventSub says `follow`; the Helix reference says `follower`. Both mean the follower goal. */
export function twitchGoalType(value: unknown): TwitchGoalType {
  const type = value === 'follower' ? 'follow' : value;
  return isTwitchGoalType(type) ? type : fail('Unknown Twitch goal type');
}
const description = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 40) : '';

/** One EventSub goal notification (begin, progress or end). Only id, type, amounts and start are required. */
export function parseTwitchGoalEvent(subscriptionType: string, event: Record<string, unknown>): TwitchGoalObservation {
  if (!Object.hasOwn(TWITCH_GOAL_EVENT_TYPES, subscriptionType)) fail('Invalid Twitch goal event');
  const kind = subscriptionType === 'channel.goal.end' ? 'end' : subscriptionType === 'channel.goal.begin' ? 'begin' : 'progress';
  return {
    id: twitchGoalId(event.id), type: twitchGoalType(event.type), description: description(event.description),
    current: count(event.current_amount), target: Math.max(1, count(event.target_amount)), startedAt: time(event.started_at),
    achieved: kind === 'end' ? event.is_achieved === true || event.is_achieved === 'true' : null,
    endedAt: kind === 'end' ? (event.ended_at === undefined || event.ended_at === null || event.ended_at === '' ? null : time(event.ended_at)) : null, kind
  };
}
/** One Helix `GET /goals` row (active goals only; `created_at` is the start). */
export function parseHelixGoal(row: Record<string, unknown>): Omit<TwitchGoalObservation, 'kind'> {
  return { id: twitchGoalId(row.id), type: twitchGoalType(row.type), description: description(row.description),
    current: count(row.current_amount), target: Math.max(1, count(row.target_amount)), startedAt: time(row.created_at), achieved: null, endedAt: null };
}

const RECEIPTS = 20, MAX_GOALS = 20, KEEP_MS = 86_400_000;
/** A Helix read only overwrites amounts when no event came in shortly before it (Helix can lag behind EventSub). */
const HELIX_EVENT_GRACE_MS = 30_000;
const ms = (value: string | null) => value === null ? NaN : Date.parse(value);
const empty = (): StoredTwitchGoals => ({ goals: [], receipts: [], access: null, checkedAt: null });
/** Ended and missing goals are kept a day (late events, actions), at most 20 goals. */
function prune(goals: TwitchGoal[], now: number): TwitchGoal[] {
  return goals.filter(goal => goal.phase === 'active' || now - ms(goal.phase === 'ended' ? goal.endedAt ?? goal.eventAt : goal.missingSince) < KEEP_MS)
    .sort((a, b) => ms(b.startedAt) - ms(a.startedAt)).slice(0, MAX_GOALS);
}
/** An event that shows the crossing more than this after a Helix read already saw it there means the real one was missed. */
const LATE_CROSSING_MS = 10 * 60_000;
/**
 * Latches `reachedAt`. Only an event counts as the crossing, and only for a goal known to have been below its target:
 * a goal first seen already there is a baseline. A Helix read of a goal known below its target doesn't latch (the event
 * showing the crossing may still be on its way); it notes when, so a much later event isn't taken for the crossing.
 */
function reach(goal: TwitchGoal, at: string, byEvent: boolean): void {
  if (goal.reachedAt || !(goal.current >= goal.target || goal.achieved === true)) return;
  if (!byEvent && goal.seenBelow) { goal.aboveSeenAt ??= at; return; }
  // A Helix read already saw it there: the crossing happened by then, not at this later event (an action saved in
  // between must not run).
  goal.reachedAt = goal.aboveSeenAt && ms(goal.aboveSeenAt) < ms(at) ? goal.aboveSeenAt : at;
  goal.reachedBy = byEvent && goal.seenBelow && !(goal.aboveSeenAt && ms(at) - ms(goal.aboveSeenAt) > LATE_CROSSING_MS) ? 'event' : 'baseline';
}

/**
 * EventSub ordering: duplicates are ignored; an event older than the newest applied event changes nothing (net goals can
 * go down, so amounts are never max()ed); Twitch's end is final and never goes back to active. A goal Helix stopped
 * listing (`missing`) comes back with any newer event. `reachedAt` latches the first time it's at or past its target.
 */
export function reduceTwitchGoalEvent(stored: StoredTwitchGoals | null, next: TwitchGoalObservation, at: string, receipt: string, now = Date.now()): StoredTwitchGoals | null {
  const state = stored ?? empty();
  if (state.receipts.includes(receipt)) return null;
  const goals = state.goals.map(goal => ({ ...goal })), old = goals.find(goal => goal.id === next.id);
  const goal: TwitchGoal = old ?? { id: next.id, type: next.type, description: next.description, current: next.current, target: next.target, startedAt: next.startedAt,
    phase: 'active', achieved: null, endedAt: null, eventAt: null, seenAt: null, missingSince: null, seenBelow: false, aboveSeenAt: null, reachedAt: null, reachedBy: null };
  if (old?.phase === 'ended') return null;
  const ending = next.kind === 'end';
  if (old?.eventAt && !ending && ms(at) < ms(old.eventAt)) return null;
  if (old && (!old.eventAt || ms(at) >= ms(old.eventAt) || ending)) {
    goal.current = next.current; goal.target = next.target; goal.description = next.description;
  }
  if (!old || !goal.eventAt || ms(at) > ms(goal.eventAt)) goal.eventAt = at;
  if (ending) { goal.phase = 'ended'; goal.achieved = next.achieved; goal.endedAt = next.endedAt ?? at; goal.missingSince = null; }
  // A delayed event from before Helix stopped listing it doesn't bring it back.
  else if (goal.phase === 'missing' && ms(at) > ms(goal.missingSince)) { goal.phase = 'active'; goal.missingSince = null; }
  reach(goal, ending && goal.achieved ? goal.endedAt! : at, true);
  // Ended after a Helix read saw it reached (then it dipped): it was reached, so "ends unreached" never applies.
  if (ending && !goal.reachedAt && goal.aboveSeenAt) { goal.reachedAt = goal.aboveSeenAt; goal.reachedBy = 'baseline'; }
  if (next.current < next.target && !(ending && goal.achieved)) goal.seenBelow = true;
  if (!old) goals.push(goal);
  return { ...state, goals: prune(goals, now), receipts: [receipt, ...state.receipts].slice(0, RECEIPTS) };
}

/**
 * Helix recovery (active goals only, read at `fetchedAt`): new goals are added, listed goals refresh their amounts unless
 * an event came in during the grace window, and active goals it doesn't list become `missing` (not ended: an empty or
 * stale answer must not end a goal for good). A goal first seen at or past its target is a baseline: no action runs.
 */
export function reduceTwitchGoalsHelix(stored: StoredTwitchGoals | null, rows: Omit<TwitchGoalObservation, 'kind'>[], fetchedAt: string, now = Date.now()): StoredTwitchGoals {
  const state = stored ?? empty(), goals = state.goals.map(goal => ({ ...goal })), fetched = ms(fetchedAt), listed = new Set<string>();
  for (const row of rows) {
    listed.add(row.id);
    let goal = goals.find(item => item.id === row.id);
    if (goal?.phase === 'ended') continue;
    if (!goal) {
      goal = { ...row, phase: 'active', eventAt: null, seenAt: null, missingSince: null, seenBelow: false, aboveSeenAt: null, reachedAt: null, reachedBy: null };
      goals.push(goal);
    } else if (!goal.eventAt || fetched - ms(goal.eventAt) > HELIX_EVENT_GRACE_MS) {
      goal.current = row.current; goal.target = row.target; goal.description = row.description;
    }
    goal.seenAt = fetchedAt;
    if (goal.phase === 'missing') { goal.phase = 'active'; goal.missingSince = null; }
    reach(goal, fetchedAt, false);
    if (goal.current < goal.target) goal.seenBelow = true;
  }
  for (const goal of goals) {
    if (goal.phase !== 'active' || listed.has(goal.id)) continue;
    // Started (or last moved) after the request went out: Helix may not know it yet.
    if (ms(goal.startedAt) > fetched - 5000 || (goal.eventAt && ms(goal.eventAt) > fetched - 5000)) continue;
    goal.phase = 'missing'; goal.missingSince = fetchedAt;
  }
  return { ...state, goals: prune(goals, now), access: 'ok', checkedAt: fetchedAt };
}
/** Helix said the streamer hasn't granted `channel:read:goals` (goals already known stay as they are). */
export const twitchGoalsPermission = (stored: StoredTwitchGoals | null, at: string): StoredTwitchGoals => ({ ...(stored ?? empty()), access: 'permission', checkedAt: at });

export type TwitchGoalStatus = 'active' | 'reached' | 'ended';
const ENDED_VISIBLE_MS = 2 * 3_600_000;
/** What people see: active goals, and ended ones for two hours. `missing` goals are hidden (probably ended). */
export function visibleTwitchGoals(stored: StoredTwitchGoals | null, now: number): (TwitchGoal & { status: TwitchGoalStatus })[] {
  return (stored?.goals ?? [])
    .filter(goal => goal.phase === 'active' || goal.phase === 'ended' && now - ms(goal.endedAt) < ENDED_VISIBLE_MS)
    .map(goal => ({ ...goal, status: goal.phase === 'ended' ? 'ended' as const : goal.current >= goal.target ? 'reached' as const : 'active' as const }))
    .sort((a, b) => (a.status === 'ended' ? 1 : 0) - (b.status === 'ended' ? 1 : 0) || ms(b.startedAt) - ms(a.startedAt));
}

/** A Twitch goal as the Goals page sees it (times in ms). `outcome` is filled in by the goals service. */
export interface TwitchGoalView {
  id: string; type: TwitchGoalType; description: string; current: number; target: number; percent: number;
  status: TwitchGoalStatus; achieved: boolean | null; startedAt: number; endedAt: number | null;
}
export function twitchGoalViews(stored: StoredTwitchGoals | null, now: number): TwitchGoalView[] {
  return visibleTwitchGoals(stored, now).map(goal => ({ id: goal.id, type: goal.type, description: goal.description, current: goal.current, target: goal.target,
    percent: Math.min(100, goal.current / goal.target * 100), status: goal.status, achieved: goal.achieved, startedAt: ms(goal.startedAt), endedAt: goal.endedAt ? ms(goal.endedAt) : null }));
}

/** How a Twitch goal counts, in the metric words custom widgets already use (plus sub points and cheerers). */
export const TWITCH_GOAL_METRIC: Record<TwitchGoalType, 'follows' | 'subs' | 'subPoints' | 'bits' | 'cheerers'> = {
  follow: 'follows', subscription: 'subPoints', subscription_count: 'subs', new_subscription: 'subPoints', new_subscription_count: 'subs', new_bit: 'bits', new_cheerer: 'cheerers'
};
/** Widget-facing name when the streamer gave the goal no description (Twitch's own wording is per language; these stay English). */
const TYPE_NAMES: Record<TwitchGoalType, string> = {
  follow: 'Follower goal', subscription: 'Sub points goal', subscription_count: 'Sub goal', new_subscription: 'New sub points goal',
  new_subscription_count: 'New sub goal', new_bit: 'Bits goal', new_cheerer: 'Cheerer goal'
};
export interface PublicTwitchGoal {
  id: string; source: 'twitch'; twitchType: TwitchGoalType; name: string; metric: typeof TWITCH_GOAL_METRIC[TwitchGoalType]; mode: 'twitch';
  target: number; current: number; percent: number; currency: null; status: TwitchGoalStatus; achieved: boolean | null;
  startsAt: number; endsAt: number | null; windowSeconds: null; period: null;
}
/** Twitch goals as custom widgets see them (`Dima.state('goals')` items with `source: 'twitch'`): progress only. */
export function publicTwitchGoals(goals: readonly TwitchGoalView[]): PublicTwitchGoal[] {
  return goals.map(goal => ({
    id: goal.id, source: 'twitch', twitchType: goal.type, name: goal.description || TYPE_NAMES[goal.type], metric: TWITCH_GOAL_METRIC[goal.type], mode: 'twitch',
    target: goal.target, current: goal.current, percent: Math.round(goal.percent * 10) / 10, currency: null,
    status: goal.status, achieved: goal.achieved, startsAt: goal.startedAt, endsAt: goal.endedAt, windowSeconds: null, period: null
  }));
}

/** StreamElements `*-goal` keys for Twitch-sourced layers. Sub goals prefer counts over points; Twitch has no money goals. */
const SE_TWITCH_TYPES: Record<string, readonly TwitchGoalType[]> = {
  'follower-goal': ['follow'], 'subscriber-goal': ['new_subscription_count', 'subscription_count', 'new_subscription', 'subscription'], 'cheer-goal': ['new_bit'], 'tip-goal': []
};
export function seTwitchGoals(goals: readonly TwitchGoalView[]): { data: Record<string, { amount: number }>; sources: Record<string, { id: string; name: string; status: string }> } {
  const data: Record<string, { amount: number }> = {}, sources: Record<string, { id: string; name: string; status: string }> = {};
  for (const [key, types] of Object.entries(SE_TWITCH_TYPES)) {
    // Like our goals: the first active one of that kind, else a reached one.
    const pick = (status: TwitchGoalStatus) => types.map(type => goals.find(goal => goal.type === type && goal.status === status)).find(Boolean);
    const goal = pick('active') ?? pick('reached');
    data[key] = { amount: goal?.current ?? 0 };
    if (goal) sources[key] = { id: goal.id, name: goal.description || TYPE_NAMES[goal.type], status: goal.status };
  }
  return { data, sources };
}
