/**
 * One place for how the admin writes numbers, money and time. Pages import these instead of adding
 * their own copies.
 */
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 1,234 (rounded). Missing values show as an em dash so a column never reads as zero by accident. */
export function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? INT.format(value) : '—';
}

/** 1.2K, 3.4M for tight spots; whole numbers stay whole under 1,000. */
export function formatCompact(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.abs(value) < 1000 ? INT.format(value) : COMPACT.format(value);
}

/** AI credits are priced so that 1,000 credits = 1 US cent. */
export const CREDITS_PER_USD = 100_000;
export const creditsToUSD = (credits: number): number => credits / CREDITS_PER_USD;

/**
 * Dollars at the precision that still says something: $12.40, $0.38, $0.0042, <$0.0001.
 * AI costs here are often fractions of a cent, so two decimals would show most of them as $0.00.
 */
export function formatUSD(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs === 0) return '$0';
  if (abs < 0.0001) return `${sign}<$0.0001`;
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits })}`;
}

/** "74 credits", "1 credit", "1.2M credits". */
export function formatCredits(value: number | null | undefined, compact = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  return `${compact ? formatCompact(rounded) : INT.format(rounded)} ${Math.abs(rounded) === 1 ? 'credit' : 'credits'}`;
}

/** What a number of credits is worth in dollars: "≈ $0.74". */
export function formatCreditValue(credits: number | null | undefined): string {
  return typeof credits === 'number' && Number.isFinite(credits) ? `≈ ${formatUSD(creditsToUSD(credits))}` : '—';
}

/** 420 ms, 1.4 s, 2 min 5 s. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** 12%, 0.4%, <0.1%. `part` and `total` are counts. */
export function formatShare(part: number, total: number): string {
  if (!total || !Number.isFinite(part / total)) return '0%';
  const percent = (part / total) * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent >= 10 || percent === 0 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** "just now", "4 min ago", "3 h ago", "yesterday", then "Nov 4" (with the year when it is not this year). */
export function relativeTime(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172_800) return 'yesterday';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Nov 4, 3:07 PM" in the viewer's time zone (with the year when it is not this year). */
export function dateTime(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "3:07:42 PM": for rows that are already grouped under a day heading. */
export function clockTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
}

/** "Today", "Yesterday", "Tue, Nov 4": a day heading in the viewer's time zone. */
export function dayLabel(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const start = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Local calendar day key (YYYY-MM-DD) for grouping rows under day headings. */
export function localDayKey(value: string | number | Date): string {
  const date = toDate(value) || new Date(0);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Nov 4" for a `YYYY-MM-DD` day from the API (a UTC day: parsed as a calendar date, never shifted by the time zone). */
export function shortDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Plain plural: `plural(1, 'ban')` → "1 ban", `plural(3, 'reply', 'replies')` → "3 replies". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** ISO time `hours` (or days) before now, for range filters. */
export const hoursAgo = (hours: number, now: number = Date.now()): string => new Date(now - hours * 3_600_000).toISOString();

/** The time ranges list pages offer. `hours` is how far back the range reaches. */
export const RANGES = [
  { key: '1h', label: '1 hour', short: '1h', hours: 1 },
  { key: '24h', label: '24 hours', short: '24h', hours: 24 },
  { key: '7d', label: '7 days', short: '7d', hours: 168 },
  { key: '30d', label: '30 days', short: '30d', hours: 720 },
] as const;
export type RangeKey = (typeof RANGES)[number]['key'];
export const rangeHours = (key: RangeKey): number => RANGES.find((range) => range.key === key)!.hours;
export const isRangeKey = (value: unknown): value is RangeKey => RANGES.some((range) => range.key === value);
