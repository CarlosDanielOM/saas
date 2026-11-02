import { GoalError } from './model.js';

export interface GoalMonth { key: string; startsAt: number; endsAt: number }
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const monthCache = new Map<string, GoalMonth>();

export function goalTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /^[+-]/.test(value)) throw new GoalError('invalid', 'Choose an IANA time zone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { throw new GoalError('invalid', 'Choose an IANA time zone'); }
  return value;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let instance = formatterCache.get(timeZone);
  if (!instance) {
    instance = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: goalTimeZone(timeZone), year: 'numeric', month: '2-digit' });
    // Keep user-supplied zone variants from growing the cache without bound.
    if (formatterCache.size >= 128) formatterCache.clear();
    formatterCache.set(timeZone, instance);
  }
  return instance;
}

function indexAt(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(at);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  return year * 12 + month - 1;
}

function startOfIndex(index: number, timeZone: string): number {
  const year = Math.floor(index / 12), month = index % 12;
  const nominal = Date.UTC(year, month, 1);
  let lo = nominal - 48 * 3600_000, hi = nominal + 48 * 3600_000;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (indexAt(middle, timeZone) < index) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

export function goalMonthForKey(key: string, timeZone: string): GoalMonth {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new GoalError('invalid', 'Invalid goal month');
  const cacheKey = `${timeZone}\0${key}`;
  const cached = monthCache.get(cacheKey);
  if (cached) return { ...cached };
  const [year, month] = key.split('-').map(Number), index = year * 12 + month - 1;
  const period = { key, startsAt: startOfIndex(index, timeZone), endsAt: startOfIndex(index + 1, timeZone) };
  if (monthCache.size >= 512) monthCache.clear();
  monthCache.set(cacheKey, period);
  return { ...period };
}

export function goalMonthAt(at: number, timeZone: string): GoalMonth {
  if (!Number.isFinite(at)) throw new GoalError('invalid', 'Invalid goal time');
  const index = indexAt(at, timeZone), year = Math.floor(index / 12), month = index % 12 + 1;
  return goalMonthForKey(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`, timeZone);
}

export function nextGoalMonth(key: string, timeZone: string): GoalMonth {
  const period = goalMonthForKey(key, timeZone);
  return goalMonthAt(period.endsAt, timeZone);
}
