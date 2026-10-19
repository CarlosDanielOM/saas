import type { DashboardStreamHistoryPoint } from '../../models/dashboard.model';
import type {
  ModerationAction,
  ModerationActionLogEntry,
  ModerationRuleType
} from '../../models/moderation.model';

const DAY_MS = 86_400_000;

export interface WeekTotals {
  streams: number;
  hours: number;
  follows: number;
  subs: number;
  bits: number;
  /** Average of each stream's average viewers. */
  viewers: number;
}

export interface WeekCompare {
  now: WeekTotals;
  before: WeekTotals;
  /** First day of the 7-day window (local midnight). */
  from: Date;
  to: Date;
  /** Start time of the newest stream in the history, if any. */
  lastStream: string | null;
}

function totals(list: DashboardStreamHistoryPoint[]): WeekTotals {
  const sum = (pick: (p: DashboardStreamHistoryPoint) => number) =>
    list.reduce((acc, p) => acc + (Number.isFinite(pick(p)) ? pick(p) : 0), 0);
  return {
    streams: list.length,
    hours: Math.round(sum((p) => p.hours) * 10) / 10,
    follows: sum((p) => p.follows),
    subs: sum((p) => p.subs),
    bits: sum((p) => p.bits),
    viewers: list.length ? Math.round(sum((p) => p.viewers) / list.length) : 0
  };
}

/** Last 7 days (today included) against the 7 days before, from per-stream history. */
export function compareWeeks(history: DashboardStreamHistoryPoint[], now = new Date()): WeekCompare {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const from = new Date(today.getTime() - 6 * DAY_MS);
  const beforeFrom = new Date(from.getTime() - 7 * DAY_MS);
  const at = (p: DashboardStreamHistoryPoint) => new Date(p.date).getTime();

  const valid = history.filter((p) => Number.isFinite(at(p)));
  const thisWeek = valid.filter((p) => at(p) >= from.getTime());
  const lastWeek = valid.filter((p) => at(p) >= beforeFrom.getTime() && at(p) < from.getTime());
  const newest = valid.reduce<DashboardStreamHistoryPoint | null>(
    (best, p) => (!best || at(p) > at(best) ? p : best),
    null
  );

  return { now: totals(thisWeek), before: totals(lastWeek), from, to: today, lastStream: newest?.date ?? null };
}

/** Whole-number % change, or null when there is nothing to compare against. */
export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

export const RULE_TYPES: ModerationRuleType[] = ['links', 'caps', 'emote_spam', 'blacklist'];
export const SANCTION_ACTIONS: Exclude<ModerationAction, 'off'>[] = ['delete', 'warn', 'timeout', 'ban'];

export interface AutomodWeek {
  /** Actions in the last 7 days. */
  actions: number;
  /** True when more actions happened than the loaded page covers. */
  capped: boolean;
  /** Actions in the 7 days before, or null when the loaded logs don't reach that far. */
  prevActions: number | null;
  byRule: Array<{ key: ModerationRuleType; hits: number }>;
  byAction: Record<Exclude<ModerationAction, 'off'>, number>;
  /** People with 2+ actions this week, most first. */
  repeat: Array<{ user: string; count: number }>;
}

/**
 * Sums a page of moderation logs (newest first) into this week's automod
 * numbers. `total` is the server's count for the whole visible window.
 */
export function summarizeAutomod(logs: ModerationActionLogEntry[], total: number, now = new Date()): AutomodWeek {
  const weekStart = now.getTime() - 7 * DAY_MS;
  const prevStart = now.getTime() - 14 * DAY_MS;
  const at = (l: ModerationActionLogEntry) => new Date(l.createdAt).getTime();
  const week = logs.filter((l) => at(l) >= weekStart);
  const prev = logs.filter((l) => at(l) >= prevStart && at(l) < weekStart);
  const oldest = logs.length ? Math.min(...logs.map(at)) : now.getTime();
  const complete = total <= logs.length;

  const byAction = { delete: 0, warn: 0, timeout: 0, ban: 0 };
  const byUser = new Map<string, number>();
  for (const l of week) {
    if (l.action in byAction) byAction[l.action as keyof typeof byAction] += 1;
    const user = l.username || l.userID;
    byUser.set(user, (byUser.get(user) ?? 0) + 1);
  }

  return {
    actions: week.length,
    capped: !complete && oldest >= weekStart,
    prevActions: complete || oldest < prevStart ? prev.length : null,
    byRule: RULE_TYPES.map((key) => ({ key, hits: week.filter((l) => l.ruleType === key).length })).filter((r) => r.hits > 0),
    byAction,
    repeat: [...byUser.entries()]
      .filter(([, count]) => count >= 2)
      .map(([user, count]) => ({ user, count }))
      .sort((a, b) => b.count - a.count)
  };
}
