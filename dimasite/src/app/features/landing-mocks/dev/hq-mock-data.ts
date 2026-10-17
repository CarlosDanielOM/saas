/**
 * Fixture + maths for the "channel + bot" dashboard proposals
 * (/mocks/dev/dashboard-split, -widgets, -briefing), built from a streamer's
 * brief: useful channel numbers (most watched games, raids, habits with tips,
 * best days), a way to choose what shows, bot info that is always there
 * (status, credits, automod, sanctions, top commands, top emotes) and quick
 * buttons to the modules used most.
 *
 * Growth numbers come from growth-mock-data so both proposal sets agree.
 * Bot numbers are a fixed week (Oct 10–16, 2026). Every tip is computed here.
 */

import {
  GAME_LABELS,
  GameKey,
  GROWTH_STREAMS,
  consistencyStats,
  gameStats,
  insightStreams,
  lengthBuckets,
  raidStats,
  streamsInWindow,
  sum,
  weekdayStats
} from './growth-mock-data';

// ------------------------------------------------------------ bot status

export const BOT_STATUS = {
  eventsOn: 11,
  eventsTotal: 11,
  /** Days since the bot last restarted. */
  uptimeDays: 12,
  repliesWeek: 427,
  /** ISO date of the bot's last reply in chat (the last stream). */
  lastReply: '2026-10-16'
};

// -------------------------------------------------------------- automod

export type RuleKey = 'links' | 'caps' | 'emote_spam' | 'blacklist';
export type ActionKey = 'delete' | 'warn' | 'timeout' | 'ban';

export interface Sanction {
  user: string;
  rule: RuleKey;
  action: ActionKey;
  date: string;
  /** Offense number inside the offense window. */
  offense: number;
}

/** Everything the automod did in the last 7 days (newest first). */
export const SANCTIONS: Sanction[] = [
  { user: 'spam_bot_4821', rule: 'links', action: 'ban', date: '2026-10-16', offense: 3 },
  { user: 'xXgamerXx', rule: 'caps', action: 'timeout', date: '2026-10-16', offense: 2 },
  { user: 'toxic_tom22', rule: 'blacklist', action: 'timeout', date: '2026-10-15', offense: 3 },
  { user: 'lurker_joe', rule: 'emote_spam', action: 'delete', date: '2026-10-15', offense: 1 },
  { user: 'toxic_tom22', rule: 'blacklist', action: 'warn', date: '2026-10-13', offense: 2 },
  { user: 'toxic_tom22', rule: 'blacklist', action: 'warn', date: '2026-10-13', offense: 1 }
];

export const AUTOMOD_WEEK = {
  checked: 9_840,
  actions: 46,
  prevActions: 61,
  rules: [
    { key: 'links' as RuleKey, hits: 19 },
    { key: 'caps' as RuleKey, hits: 12 },
    { key: 'emote_spam' as RuleKey, hits: 9 },
    { key: 'blacklist' as RuleKey, hits: 6 }
  ],
  byAction: { delete: 31, warn: 9, timeout: 5, ban: 1 } as Record<ActionKey, number>,
  /** Rules switched off in the moderation module. */
  rulesOff: [] as RuleKey[]
};

/** People with 2+ automod actions this week, most first. */
export function repeatOffenders(): Array<{ user: string; count: number; last: ActionKey }> {
  const byUser = new Map<string, Sanction[]>();
  for (const s of SANCTIONS) byUser.set(s.user, [...(byUser.get(s.user) ?? []), s]);
  return [...byUser.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([user, list]) => ({ user, count: list.length, last: list[0].action }))
    .sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------ commands + emotes

export interface UsageRow {
  name: string;
  uses: number;
  prev: number;
}

export const TOP_COMMANDS: UsageRow[] = [
  { name: '!discord', uses: 142, prev: 118 },
  { name: '!duel', uses: 96, prev: 40 },
  { name: '!lurk', uses: 88, prev: 91 },
  { name: '!so', uses: 41, prev: 37 },
  { name: '!rank', uses: 33, prev: 45 },
  { name: '!uptime', uses: 27, prev: 30 }
];

/** Custom commands nobody used in the last 30 days. */
export const UNUSED_COMMANDS = ['!merch', '!specs', '!schedule2', '!tiktok'];

export interface EmoteRow extends UsageRow {
  /** Twitch emote id, for the real image. */
  id: string;
}

export const TOP_EMOTES: EmoteRow[] = [
  { name: 'LUL', id: '425618', uses: 612, prev: 540 },
  { name: 'PogChamp', id: '305954156', uses: 488, prev: 302 },
  { name: 'Kappa', id: '25', uses: 301, prev: 320 },
  { name: 'NotLikeThis', id: '58765', uses: 214, prev: 190 },
  { name: 'SeemsGood', id: '64138', uses: 160, prev: 171 },
  { name: 'HeyGuys', id: '30259', uses: 122, prev: 98 }
];

export function emoteUrl(id: string, dark: boolean): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/${dark ? 'dark' : 'light'}/2.0`;
}

export function change(row: UsageRow): number {
  return row.prev ? Math.round(((row.uses - row.prev) / row.prev) * 100) : 0;
}

// --------------------------------------------------------------- modules

export type ModuleKey = 'tts' | 'chatEvents' | 'triggers' | 'moderation' | 'commands' | 'dimafx' | 'duel' | 'clips';
export type ModuleIcon = 'mic' | 'chat' | 'play' | 'shield' | 'terminal' | 'bits' | 'swords' | 'monitor';

export interface ModuleUse {
  key: ModuleKey;
  icon: ModuleIcon;
  /** Times you opened it in the last 30 days (orders "most used"). */
  visits: number;
  /** This week's number shown on the button. */
  stat: number;
}

export const MODULES: ModuleUse[] = [
  { key: 'tts', icon: 'mic', visits: 41, stat: 214 },
  { key: 'chatEvents', icon: 'chat', visits: 33, stat: 63 },
  { key: 'triggers', icon: 'play', visits: 29, stat: 38 },
  { key: 'moderation', icon: 'shield', visits: 22, stat: AUTOMOD_WEEK.actions },
  { key: 'commands', icon: 'terminal', visits: 17, stat: BOT_STATUS.repliesWeek },
  { key: 'dimafx', icon: 'bits', visits: 9, stat: 12 },
  { key: 'duel', icon: 'swords', visits: 6, stat: 96 },
  { key: 'clips', icon: 'monitor', visits: 4, stat: 4 }
];

export const MOST_USED: ModuleKey[] = [...MODULES].sort((a, b) => b.visits - a.visits).slice(0, 4).map((m) => m.key);

export function moduleByKey(key: ModuleKey): ModuleUse {
  return MODULES.find((m) => m.key === key)!;
}

// ------------------------------------------------------- most watched games

export interface WatchedGame {
  game: GameKey;
  label: string;
  /** Viewer-hours: average viewers × hours live. */
  watched: number;
  share: number;
  streams: number;
  avgViewers: number;
  followsPerHour: number;
}

export function mostWatchedGames(list = insightStreams()): WatchedGame[] {
  const total = sum(list.map((s) => s.avgViewers * s.hours));
  const rates = new Map(gameStats(list).map((g) => [g.game, g]));
  return (Object.keys(GAME_LABELS) as GameKey[])
    .map((game) => {
      const on = list.filter((s) => s.game === game);
      const watched = sum(on.map((s) => s.avgViewers * s.hours));
      const hours = sum(on.map((s) => s.hours));
      return {
        game,
        label: GAME_LABELS[game],
        watched: Math.round(watched),
        share: Math.round((watched / total) * 100),
        streams: on.length,
        avgViewers: hours ? Math.round(watched / hours) : 0,
        followsPerHour: rates.get(game)?.followsPerHour ?? 0
      };
    })
    .filter((g) => g.streams > 0)
    .sort((a, b) => b.watched - a.watched);
}

// ------------------------------------------------------------------ raids

/** Raids you sent at the end of a stream (last 14 weeks). */
export const RAIDS_OUT = [
  { to: 'kayla_irl', date: '2026-08-02', viewers: 31 },
  { to: 'tinybluecat', date: '2026-09-06', viewers: 34 }
];

export function raidSummary() {
  const r = raidStats();
  const sentTo = new Set(RAIDS_OUT.map((x) => x.to));
  const owed = r.raids.filter((x) => !sentTo.has(x.from)).sort((a, b) => b.follows - a.follows);
  return { ...r, out: RAIDS_OUT, owed, streams: insightStreams().length };
}

// ----------------------------------------------------------- habits + tips

export type HabitKey = 'shortStreams' | 'weakDay' | 'quietWeeks' | 'raidBack' | 'sweetSpot';
export type TipTone = 'fix' | 'good';

export interface Habit {
  key: HabitKey;
  tone: TipTone;
  /** Values for the translated sentence. */
  vars: Record<string, string | number>;
  /** Bars for the evidence chart: label + value, the highlighted one first in meaning. */
  bars: Array<{ label: string; value: number; mark?: 'bad' | 'good' }>;
  unit: string;
  module?: ModuleKey;
}

/** Bad habits worth fixing, biggest impact first, plus one good habit to keep. */
export function habits(): Habit[] {
  const list = insightStreams();
  const lengths = lengthBuckets(list);
  const short = lengths.find((b) => b.key === 'short')!;
  const sweet = lengths.reduce((a, b) => (b.followsPerHour > a.followsPerHour ? b : a));
  const long = lengths.find((b) => b.key === 'long')!;
  const days = weekdayStats(list).filter((d) => d.streams >= 3);
  const best = days.reduce((a, b) => (b.followsPerStream > a.followsPerStream ? b : a));
  const worst = days.reduce((a, b) => (b.followsPerStream < a.followsPerStream ? b : a));
  const worstGame = list.find((s) => s.weekday === worst.weekday)?.game ?? 'chatting';
  const weeks = consistencyStats();
  const raids = raidSummary();
  const owed = raids.owed[0];

  const lessPct = (a: number, b: number) => Math.round((1 - a / b) * 100);

  return [
    {
      key: 'shortStreams',
      tone: 'fix',
      vars: { count: short.streams, total: list.length, less: lessPct(short.followsPerHour, sweet.followsPerHour) },
      bars: lengths.map((b) => ({ label: b.key, value: b.followsPerHour, mark: b.key === 'short' ? 'bad' : b.key === sweet.key ? 'good' : undefined })),
      unit: 'perHour'
    },
    {
      key: 'weakDay',
      tone: 'fix',
      vars: { worst: worst.weekday, best: best.weekday, game: GAME_LABELS[worstGame], ratio: Math.round((best.followsPerStream / worst.followsPerStream) * 10) / 10 },
      bars: weekdayStats(list).map((d) => ({ label: 'd' + d.weekday, value: d.followsPerStream, mark: d.weekday === worst.weekday ? 'bad' : d.weekday === best.weekday ? 'good' : undefined })),
      unit: 'perStream'
    },
    {
      key: 'raidBack',
      tone: 'fix',
      vars: { received: raids.raids.length, sent: raids.out.length, streams: raids.streams, who: owed.from, follows: owed.follows },
      bars: raids.raids.map((r) => ({ label: r.from, value: r.follows, mark: raids.owed.some((o) => o.from === r.from) ? 'bad' : 'good' })),
      unit: 'follows'
    },
    {
      key: 'quietWeeks',
      tone: 'fix',
      vars: { quiet: weeks.quietWeeks, quietAvg: Math.round(weeks.quietAvg), busyAvg: Math.round(weeks.busyAvg) },
      bars: [
        { label: 'busy', value: weeks.busyAvg, mark: 'good' },
        { label: 'quiet', value: weeks.quietAvg, mark: 'bad' }
      ],
      unit: 'perWeek'
    },
    {
      key: 'sweetSpot',
      tone: 'good',
      vars: { sweet: sweet.key, rate: Math.round(sweet.followsPerHour * 10) / 10, long: long.streams },
      bars: lengths.map((b) => ({ label: b.key, value: b.followsPerHour, mark: b.key === sweet.key ? 'good' : undefined })),
      unit: 'perHour'
    }
  ];
}

// ------------------------------------------------------------- this week

export const WEEK = {
  from: '2026-10-10',
  to: '2026-10-16'
};

export function weekStreams() {
  const now = streamsInWindow(7);
  const before = streamsInWindow(14, 7);
  const s = (list: typeof now) => ({
    streams: list.length,
    hours: Math.round(sum(list.map((x) => x.hours)) * 10) / 10,
    follows: sum(list.map((x) => x.follows)),
    peak: Math.max(0, ...list.map((x) => x.peakViewers))
  });
  return { now: s(now), before: s(before), list: now };
}

/** Most recent stream, for "last stream" lines. */
export const LAST_STREAM = GROWTH_STREAMS[GROWTH_STREAMS.length - 1];
