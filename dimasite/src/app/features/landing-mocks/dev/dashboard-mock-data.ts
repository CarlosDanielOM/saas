/**
 * Fixture data shared by the two dashboard proposals (/mocks/dev/dashboard-*).
 * Deterministic so screenshots and reviews are stable. "Today" is Oct 3, 2026.
 */
export interface MockStream {
  date: string;
  hours: number;
  avgViewers: number;
  peakViewers: number;
  follows: number;
  subs: number;
  bits: number;
  tips: number;
}

export const MOCK_TODAY = '2026-10-03';

export const MOCK_CHANNEL = {
  login: 'novaplays',
  name: 'NovaPlays',
  plan: 'pro' as const,
  avatar: '',
  followers: 4182,
  subs: 61,
  lastTitle: 'Ranked grind to Diamond | !discord !uptime',
  lastGame: 'Valorant'
};

/** Newest first. The Sep 21 stream got a 40-viewer raid. */
export const MOCK_STREAMS: MockStream[] = [
  { date: '2026-10-01', hours: 3.2, avgViewers: 46, peakViewers: 71, follows: 18, subs: 3, bits: 1200, tips: 15 },
  { date: '2026-09-29', hours: 4.1, avgViewers: 52, peakViewers: 88, follows: 27, subs: 5, bits: 2600, tips: 0 },
  { date: '2026-09-27', hours: 2.5, avgViewers: 38, peakViewers: 60, follows: 9, subs: 1, bits: 300, tips: 5 },
  { date: '2026-09-25', hours: 3.8, avgViewers: 44, peakViewers: 74, follows: 14, subs: 2, bits: 900, tips: 0 },
  { date: '2026-09-23', hours: 3.0, avgViewers: 41, peakViewers: 66, follows: 11, subs: 4, bits: 450, tips: 20 },
  { date: '2026-09-21', hours: 5.2, avgViewers: 63, peakViewers: 120, follows: 41, subs: 9, bits: 5100, tips: 35 },
  { date: '2026-09-19', hours: 2.8, avgViewers: 35, peakViewers: 52, follows: 7, subs: 1, bits: 150, tips: 0 },
  { date: '2026-09-17', hours: 3.4, avgViewers: 39, peakViewers: 58, follows: 10, subs: 2, bits: 600, tips: 0 },
  { date: '2026-09-15', hours: 3.1, avgViewers: 37, peakViewers: 55, follows: 8, subs: 0, bits: 200, tips: 10 },
  { date: '2026-09-13', hours: 4.0, avgViewers: 42, peakViewers: 70, follows: 13, subs: 3, bits: 1100, tips: 0 },
  { date: '2026-09-11', hours: 2.2, avgViewers: 31, peakViewers: 47, follows: 5, subs: 1, bits: 0, tips: 0 },
  { date: '2026-09-09', hours: 3.6, avgViewers: 36, peakViewers: 61, follows: 9, subs: 2, bits: 400, tips: 5 },
  { date: '2026-09-07', hours: 3.0, avgViewers: 33, peakViewers: 50, follows: 6, subs: 1, bits: 250, tips: 0 },
  { date: '2026-09-05', hours: 2.9, avgViewers: 30, peakViewers: 49, follows: 6, subs: 0, bits: 100, tips: 0 }
];

/** Averages for the 30 days before this window, for honest "vs before" deltas. */
export const MOCK_PREVIOUS = { avgViewers: 34, followsPerStream: 9.1, hoursPerWeek: 7.9, bitsPerStream: 610 };

export const MOCK_CREDITS = { limit: 800000, used: 512400, periodDays: 30, daysIntoPeriod: 19 };

export const MOCK_GOALS = { followersGoal: 250, subsGoal: 25 };

/** Live-mode events, newest first (minutes ago). */
export const MOCK_EVENTS = [
  { kind: 'raid', who: 'pixel_pancho', amount: 23, ago: 1 },
  { kind: 'sub', who: 'luna_v', amount: 3, ago: 4 },
  { kind: 'bits', who: 'taco_fan', amount: 500, ago: 7 },
  { kind: 'redeem', who: 'kevin_irl', amount: 0, ago: 9 },
  { kind: 'follow', who: 'neo_drift', amount: 0, ago: 12 },
  { kind: 'follow', who: 'arcadia_88', amount: 0, ago: 13 }
] as const;

export type MockEventKind = (typeof MOCK_EVENTS)[number]['kind'];

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function streamsSummary() {
  const s = MOCK_STREAMS;
  const avgViewers = Math.round(sum(s.map((x) => x.avgViewers)) / s.length);
  const follows = sum(s.map((x) => x.follows));
  const subs = sum(s.map((x) => x.subs));
  const bits = sum(s.map((x) => x.bits));
  const hours = sum(s.map((x) => x.hours));
  const hoursPerWeek = hours / (30 / 7);
  const pct = (now: number, before: number) => Math.round(((now - before) / before) * 100);
  return {
    count: s.length,
    avgViewers,
    avgViewersDelta: pct(avgViewers, MOCK_PREVIOUS.avgViewers),
    follows,
    followsPerStream: follows / s.length,
    followsDelta: pct(follows / s.length, MOCK_PREVIOUS.followsPerStream),
    subs,
    bits,
    bitsPerStream: Math.round(bits / s.length),
    bitsDelta: pct(bits / s.length, MOCK_PREVIOUS.bitsPerStream),
    hours,
    hoursPerWeek,
    hoursDelta: pct(hoursPerWeek, MOCK_PREVIOUS.hoursPerWeek),
    best: s.reduce((a, b) => (b.avgViewers > a.avgViewers ? b : a))
  };
}

export function creditsForecast() {
  const { limit, used, periodDays, daysIntoPeriod } = MOCK_CREDITS;
  const left = limit - used;
  const perDay = used / daysIntoPeriod;
  const daysLeftAtPace = Math.floor(left / perDay);
  const daysToReset = periodDays - daysIntoPeriod;
  return { left, perDay, daysLeftAtPace, daysToReset, pctLeft: Math.round((left / limit) * 100), lastsUntilReset: daysLeftAtPace >= daysToReset };
}

/** Monthly goals: this month so far (Oct 1–3) is short, so goals run Sep 4 – Oct 3. */
export function goalsProgress() {
  const follows = sum(MOCK_STREAMS.map((x) => x.follows));
  const subs = sum(MOCK_STREAMS.map((x) => x.subs));
  return {
    follows,
    followsPct: Math.min(100, Math.round((follows / MOCK_GOALS.followersGoal) * 100)),
    subs,
    subsPct: Math.min(100, Math.round((subs / MOCK_GOALS.subsGoal) * 100))
  };
}

export function shortDate(iso: string, lang: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString(lang === 'es' ? 'es' : 'en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function weekday(iso: string, lang: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString(lang === 'es' ? 'es' : 'en', { weekday: 'short', timeZone: 'UTC' });
}

export function fmt(n: number, lang: string, digits = 0): string {
  return n.toLocaleString(lang === 'es' ? 'es' : 'en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function hoursLabel(h: number): string {
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return minutes ? `${whole}h ${minutes}m` : `${whole}h`;
}
