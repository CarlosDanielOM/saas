/**
 * Fixture + maths for the "How am I growing?" dashboard proposals
 * (/mocks/dev/dashboard-pulse, -path, -coach). Deterministic so reviews and
 * screenshots are stable. "Today" is Oct 17, 2026; history covers 14 weeks.
 *
 * Every sentence the mocks show is computed here from the stream list, so the
 * proposals stay honest: if the fixture changes, the claims change with it.
 */

export const GROWTH_TODAY = '2026-10-17';
const DAY = 86_400_000;
const TODAY_MS = Date.parse(GROWTH_TODAY + 'T12:00:00Z');
const HISTORY_DAYS = 182;
/** Insights look at the last 14 weeks, like the calendar. */
const INSIGHT_DAYS = 98;

export type GameKey = 'valorant' | 'dbd' | 'chatting' | 'minecraft';

export interface GrowthRaid {
  from: string;
  viewers: number;
  /** Follows in the 30 minutes after the raid landed. */
  follows: number;
}

export interface GrowthStream {
  date: string;
  /** 0 = Sunday … 6 = Saturday (UTC). */
  weekday: number;
  game: GameKey;
  title: string;
  hours: number;
  avgViewers: number;
  peakViewers: number;
  follows: number;
  subs: number;
  bits: number;
  tips: number;
  raid?: GrowthRaid;
}

export interface DailyFollowers {
  date: string;
  total: number;
  gained: number;
  stream?: GrowthStream;
}

export const GROWTH_CHANNEL = {
  login: 'novaplays',
  name: 'NovaPlays',
  followers: 4182,
  activeSubs: 61
};

export const GAME_LABELS: Record<GameKey, string> = {
  valorant: 'Valorant',
  dbd: 'Dead by Daylight',
  chatting: 'Just Chatting',
  minecraft: 'Minecraft'
};

const TITLES: Record<GameKey, string[]> = {
  valorant: ['Ranked grind to Diamond | !discord', 'Road to Immortal, no tilt allowed', 'Valorant ranked with chat picks'],
  dbd: ['Dead by Daylight: chat picks my perks', 'DBD roulette night | !wheel', 'Survivor solo queue, wish me luck'],
  chatting: ['Coffee + chat + Q&A', 'Reacting to your clips', 'Sunday chill & plans for the week'],
  minecraft: ['Hardcore Minecraft, day 1', 'Building the castle with chat']
};

/** Small seeded PRNG so the fixture is identical on every load. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAIDS: Record<string, Omit<GrowthRaid, 'follows'>> = {
  '2026-05-17': { from: 'tinybluecat', viewers: 12 },
  '2026-07-19': { from: 'kayla_irl', viewers: 18 },
  '2026-08-30': { from: 'midnightmoth', viewers: 26 },
  '2026-09-20': { from: 'pixel_pancho', viewers: 40 },
  '2026-10-04': { from: 'arcadia_88', viewers: 22 }
};

function generate(): GrowthStream[] {
  const rand = rng(20261017);
  const streams: GrowthStream[] = [];
  const weekdayFollowBoost = [1.55, 0.8, 1.4, 0.8, 1.0, 0.7, 0.85];
  const gameByDay: Record<number, GameKey> = { 0: 'valorant', 2: 'valorant', 4: 'dbd', 5: 'minecraft', 6: 'chatting' };
  const gameViewers: Record<GameKey, number> = { valorant: 1.06, dbd: 1, chatting: 0.8, minecraft: 0.86 };

  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const ms = TODAY_MS - d * DAY;
    const date = new Date(ms).toISOString().slice(0, 10);
    const weekday = new Date(ms).getUTCDay();
    const weeksAgo = Math.floor(d / 7);
    const game = gameByDay[weekday];
    if (!game) continue;
    // Friday streams only every other week; a holiday in mid-August and a
    // busy spell in June leave quiet weeks.
    if (weekday === 5 && weeksAgo % 2 === 1) continue;
    if ((weeksAgo === 8 || weeksAgo === 9) && weekday !== 4) continue;
    if ((weeksAgo === 17 || weeksAgo === 18) && weekday !== 0 && weekday !== 2) continue;
    if (weeksAgo === 5 && weekday === 4) continue;

    const t = (HISTORY_DAYS - d) / HISTORY_DAYS;
    const raidBase = RAIDS[date];
    const hours = Math.round((2 + rand() * 3.4) * 10) / 10;
    let avg = (21 + 23 * Math.pow(t, 1.7)) * gameViewers[game] * (0.9 + rand() * 0.2);
    if (raidBase) avg += raidBase.viewers * 0.45;
    avg = Math.round(avg);
    const lengthEffect = hours < 2.5 ? 0.72 : hours < 3.5 ? 0.95 : hours < 4.5 ? 1.18 : 0.86;
    const raid = raidBase ? { ...raidBase, follows: Math.round(raidBase.viewers * 0.6) } : undefined;
    const follows = Math.round(avg * 0.068 * weekdayFollowBoost[weekday] * lengthEffect * hours) + (raid?.follows ?? 0);
    const subs = Math.max(0, Math.round(avg * hours * 0.011 + (rand() - 0.5) * 2 + (raid ? 3 : 0)));
    const bits = Math.round((avg * hours * (3 + rand() * 12) + (raid ? 2400 : 0)) / 50) * 50;
    const titles = TITLES[game];
    streams.push({
      date,
      weekday,
      game,
      title: titles[Math.floor(rand() * titles.length)],
      hours,
      avgViewers: avg,
      peakViewers: Math.round(avg * (1.45 + rand() * 0.3) + (raid ? raid.viewers : 0)),
      follows,
      subs,
      bits,
      tips: rand() > 0.62 ? Math.round(rand() * 6) * 5 : 0,
      raid
    });
  }
  return streams;
}

/** Oldest first. */
export const GROWTH_STREAMS: GrowthStream[] = generate();

/** Followers gained on days without a stream (Twitch search, clips, VODs). */
const OFFLINE_FOLLOWS = [1, 2, 0, 1, 3, 1, 2];

export const DAILY_FOLLOWERS: DailyFollowers[] = (() => {
  const byDate = new Map(GROWTH_STREAMS.map((s) => [s.date, s]));
  const days: Array<Omit<DailyFollowers, 'total'>> = [];
  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const date = new Date(TODAY_MS - d * DAY).toISOString().slice(0, 10);
    const stream = byDate.get(date);
    days.push({ date, gained: stream ? stream.follows : OFFLINE_FOLLOWS[d % 7], stream });
  }
  let total = GROWTH_CHANNEL.followers - days.reduce((a, b) => a + b.gained, 0);
  return days.map((day) => ({ ...day, total: (total += day.gained) }));
})();

// ---------------------------------------------------------------- helpers

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function avg(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

export function pctChange(now: number, before: number): number {
  return before ? Math.round(((now - before) / before) * 100) : 0;
}

export function daysAgo(iso: string): number {
  return Math.round((TODAY_MS - Date.parse(iso + 'T12:00:00Z')) / DAY);
}

export function streamsInWindow(fromDaysAgo: number, toDaysAgo = 0): GrowthStream[] {
  return GROWTH_STREAMS.filter((s) => {
    const ago = daysAgo(s.date);
    return ago <= fromDaysAgo && ago > toDaysAgo;
  });
}

export function addDays(days: number): string {
  return new Date(TODAY_MS + days * DAY).toISOString().slice(0, 10);
}

export interface PeriodSummary {
  streams: number;
  hours: number;
  days: number;
  avgViewers: number;
  peakViewers: number;
  follows: number;
  subs: number;
  bits: number;
  tips: number;
}

export function summarize(list: GrowthStream[]): PeriodSummary {
  const hours = sum(list.map((s) => s.hours));
  return {
    streams: list.length,
    hours,
    days: new Set(list.map((s) => s.date)).size,
    // Twitch's own average is weighted by time on air.
    avgViewers: hours ? Math.round(sum(list.map((s) => s.avgViewers * s.hours)) / hours) : 0,
    peakViewers: Math.max(0, ...list.map((s) => s.peakViewers)),
    follows: sum(list.map((s) => s.follows)),
    subs: sum(list.map((s) => s.subs)),
    bits: sum(list.map((s) => s.bits)),
    tips: sum(list.map((s) => s.tips))
  };
}

export const LAST_30 = summarize(streamsInWindow(30));
export const PREV_30 = summarize(streamsInWindow(60, 30));

/** Followers gained per day over the last 30 days, including offline days. */
export function followPacePerDay(): number {
  return sum(DAILY_FOLLOWERS.slice(-30).map((d) => d.gained)) / 30;
}

/** Days until `target` followers at the 30-day pace, with a range from the slowest/fastest week. */
export function followerEta(target: number): { days: number; soonest: number; latest: number } | null {
  const left = target - GROWTH_CHANNEL.followers;
  if (left <= 0) return null;
  const weeks = [0, 1, 2, 3].map((w) => sum(DAILY_FOLLOWERS.slice(-(w + 1) * 7, DAILY_FOLLOWERS.length - w * 7).map((d) => d.gained)) / 7);
  const pace = followPacePerDay();
  return {
    days: Math.ceil(left / pace),
    soonest: Math.ceil(left / Math.max(...weeks)),
    latest: Math.ceil(left / Math.max(0.1, Math.min(...weeks)))
  };
}

// ---------------------------------------------------------- Twitch paths

export interface PathGoal {
  key: 'followers' | 'minutes' | 'hours' | 'days' | 'viewers';
  current: number;
  target: number;
  done: boolean;
}

/** Twitch's published Path to Affiliate / Partner goals, measured over the last 30 days. */
export function twitchPath(kind: 'affiliate' | 'partner', s: PeriodSummary = LAST_30, followers = GROWTH_CHANNEL.followers): PathGoal[] {
  const goals: Array<Omit<PathGoal, 'done'>> =
    kind === 'partner'
      ? [
          { key: 'hours', current: Math.round(s.hours * 10) / 10, target: 25 },
          { key: 'days', current: s.days, target: 12 },
          { key: 'viewers', current: s.avgViewers, target: 75 }
        ]
      : [
          { key: 'followers', current: followers, target: 50 },
          { key: 'minutes', current: Math.round(s.hours * 60), target: 500 },
          { key: 'days', current: s.days, target: 7 },
          { key: 'viewers', current: s.avgViewers, target: 3 }
        ];
  return goals.map((g) => ({ ...g, done: g.current >= g.target }));
}

/** Months until average viewers reach `target` if the month-over-month growth holds. */
export function monthsToViewers(target: number): number | null {
  const growth = LAST_30.avgViewers / Math.max(1, PREV_30.avgViewers);
  if (growth <= 1.01) return null;
  return Math.ceil(Math.log(target / LAST_30.avgViewers) / Math.log(growth));
}

/** A brand-new channel for the "Path to Affiliate" state. */
export const SMALL_CHANNEL_30: PeriodSummary = {
  streams: 5, hours: 6.5, days: 5, avgViewers: 2, peakViewers: 6, follows: 21, subs: 0, bits: 0, tips: 0
};

// -------------------------------------------------------------- insights

/** The streams every insight is based on (last 14 weeks). */
export function insightStreams(): GrowthStream[] {
  return streamsInWindow(INSIGHT_DAYS);
}

export interface WeekdayStat {
  weekday: number;
  streams: number;
  followsPerStream: number;
}

export function weekdayStats(list = streamsInWindow(INSIGHT_DAYS)): WeekdayStat[] {
  return [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
    const on = list.filter((s) => s.weekday === weekday && !s.raid);
    return { weekday, streams: on.length, followsPerStream: on.length ? avg(on.map((s) => s.follows)) : 0 };
  });
}

export interface LengthBucket {
  key: 'short' | 'mid' | 'sweet' | 'long';
  streams: number;
  followsPerHour: number;
}

export function lengthBuckets(list = streamsInWindow(INSIGHT_DAYS)): LengthBucket[] {
  const bucket = (h: number): LengthBucket['key'] => (h < 2.5 ? 'short' : h < 3.5 ? 'mid' : h < 4.5 ? 'sweet' : 'long');
  return (['short', 'mid', 'sweet', 'long'] as const).map((key) => {
    const on = list.filter((s) => bucket(s.hours) === key && !s.raid);
    return { key, streams: on.length, followsPerHour: on.length ? sum(on.map((s) => s.follows)) / sum(on.map((s) => s.hours)) : 0 };
  });
}

export function raidStats(list = streamsInWindow(INSIGHT_DAYS)) {
  const raided = list.filter((s) => s.raid);
  const raidFollows = sum(raided.map((s) => s.raid!.follows));
  const total = sum(DAILY_FOLLOWERS.slice(-INSIGHT_DAYS).map((d) => d.gained));
  return { raids: raided.map((s) => ({ date: s.date, ...s.raid! })), raidFollows, total, share: Math.round((raidFollows / total) * 100) };
}

export interface GameStat {
  game: GameKey;
  streams: number;
  avgViewers: number;
  followsPerHour: number;
}

export function gameStats(list = streamsInWindow(INSIGHT_DAYS)): GameStat[] {
  return (Object.keys(GAME_LABELS) as GameKey[])
    .map((game) => {
      const on = list.filter((s) => s.game === game && !s.raid);
      const hours = sum(on.map((s) => s.hours));
      return {
        game,
        streams: on.length,
        avgViewers: hours ? Math.round(sum(on.map((s) => s.avgViewers * s.hours)) / hours) : 0,
        followsPerHour: hours ? sum(on.map((s) => s.follows)) / hours : 0
      };
    })
    .filter((g) => g.streams > 0)
    .sort((a, b) => b.followsPerHour - a.followsPerHour);
}

export interface WeekCell {
  date: string;
  stream?: GrowthStream;
}

/** 14 Monday-first weeks for the consistency calendar, oldest first. */
export function calendarWeeks(): WeekCell[][] {
  const byDate = new Map(GROWTH_STREAMS.map((s) => [s.date, s]));
  const weeks: WeekCell[][] = [];
  // Start on the Monday 14 weeks before this week's Monday.
  const today = new Date(TODAY_MS);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const start = TODAY_MS - (mondayOffset + 13 * 7) * DAY;
  for (let w = 0; w < 14; w++) {
    const week: WeekCell[] = [];
    for (let d = 0; d < 7; d++) {
      const ms = start + (w * 7 + d) * DAY;
      const date = new Date(ms).toISOString().slice(0, 10);
      week.push({ date: ms <= TODAY_MS ? date : '', stream: byDate.get(date) });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Follower growth in weeks with 4+ streams vs weeks with only 1–2. */
export function consistencyStats() {
  const weeks = calendarWeeks().slice(0, -1); // the current week is still running
  const followsByDate = new Map(DAILY_FOLLOWERS.map((d) => [d.date, d.gained]));
  const rows = weeks
    .map((w) => ({
      streams: w.filter((c) => c.stream).length,
      follows: sum(w.map((c) => followsByDate.get(c.date) ?? 0)),
      complete: w.every((c) => followsByDate.has(c.date))
    }))
    .filter((r) => r.complete);
  const busy = rows.filter((r) => r.streams >= 4);
  const quiet = rows.filter((r) => r.streams > 0 && r.streams <= 2);
  const busyAvg = avg(busy.map((r) => r.follows));
  const quietAvg = avg(quiet.map((r) => r.follows));
  return { busyWeeks: busy.length, quietWeeks: quiet.length, busyAvg, quietAvg, ratio: quietAvg ? busyAvg / quietAvg : 0 };
}

// --------------------------------------------------------------- records

export interface GrowthRecord {
  key: 'peak' | 'avg' | 'follows' | 'bits' | 'long' | 'subs';
  value: number;
  stream: GrowthStream;
  /** Set in the last 30 days. */
  fresh: boolean;
}

export function personalRecords(): GrowthRecord[] {
  const pick = (key: GrowthRecord['key'], get: (s: GrowthStream) => number): GrowthRecord => {
    const stream = GROWTH_STREAMS.reduce((a, b) => (get(b) > get(a) ? b : a));
    return { key, value: get(stream), stream, fresh: daysAgo(stream.date) <= 30 };
  };
  return [
    pick('peak', (s) => s.peakViewers),
    pick('avg', (s) => s.avgViewers),
    pick('follows', (s) => s.follows),
    pick('bits', (s) => s.bits),
    pick('subs', (s) => s.subs),
    pick('long', (s) => s.hours)
  ];
}

export interface Milestone {
  key: string;
  metric: 'followers' | 'subs' | 'hours';
  target: number;
  /** ISO date reached, for passed milestones. */
  reached?: string;
  etaDays?: { days: number; soonest: number; latest: number } | null;
  custom?: boolean;
}

export function followerMilestones(): Milestone[] {
  const passed = [3750, 4000].map((target) => ({
    key: 'f' + target,
    metric: 'followers' as const,
    target,
    reached: DAILY_FOLLOWERS.find((d) => d.total >= target)?.date
  }));
  const next = [4250, 4500, 5000].map((target) => ({ key: 'f' + target, metric: 'followers' as const, target, etaDays: followerEta(target) }));
  return [...passed, ...next];
}

// ----------------------------------------------------------- month goals

export interface MonthGoal {
  current: number;
  target: number;
  /** Where the month ends at this month's pace so far. */
  projected: number;
  onPace: boolean;
}

/** October goal (Oct 1 → yesterday, 16 days in; 15 days left including today). */
export function monthGoal(metric: 'follows' | 'subs', target: number): MonthGoal {
  const current =
    metric === 'follows'
      ? sum(DAILY_FOLLOWERS.filter((d) => d.date >= '2026-10-01').map((d) => d.gained))
      : sum(GROWTH_STREAMS.filter((s) => s.date >= '2026-10-01').map((s) => s.subs));
  const projected = Math.round(current + (current / 16) * 15);
  return { current, target, projected, onPace: projected >= target };
}

// ------------------------------------------------------------- live mode

export const LIVE_SESSION = {
  minutes: 72,
  viewers: 58,
  peak: 64,
  follows: 6,
  subs: 2,
  bits: 800,
  game: 'valorant' as GameKey,
  title: 'Ranked grind to Diamond | !discord'
};

// ---------------------------------------------------------------- credits

export function creditsFor(plan: 'free' | 'pro') {
  const limit = plan === 'pro' ? 800_000 : 25_000;
  const used = plan === 'pro' ? 512_400 : 21_300;
  const daysInto = 19;
  const left = limit - used;
  const perDay = used / daysInto;
  const daysLeft = Math.floor(left / perDay);
  const daysToReset = 30 - daysInto;
  return { limit, left, daysLeft, daysToReset, pctLeft: Math.round((left / limit) * 100), lastsUntilReset: daysLeft >= daysToReset };
}

// ------------------------------------------------------------- formatting

export function fmt(n: number, lang: string, digits = 0): string {
  return n.toLocaleString(lang === 'es' ? 'es' : 'en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function compact(n: number, lang: string): string {
  return new Intl.NumberFormat(lang === 'es' ? 'es' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function shortDate(iso: string, lang: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString(lang === 'es' ? 'es' : 'en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function weekdayName(weekday: number, lang: string, style: 'short' | 'long' = 'short'): string {
  // Jan 4, 2026 was a Sunday.
  return new Date(Date.UTC(2026, 0, 4 + weekday, 12)).toLocaleDateString(lang === 'es' ? 'es' : 'en', { weekday: style, timeZone: 'UTC' });
}

export function hoursLabel(h: number): string {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return minutes ? `${whole}h ${minutes}m` : `${whole}h`;
}

export function signed(n: number, suffix = ''): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}${suffix}`;
}
