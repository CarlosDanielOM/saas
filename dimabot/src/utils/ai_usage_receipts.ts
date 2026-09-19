import { createHash } from 'node:crypto';

import { getDragonflyClient } from './databases/dragonfly.database.js';
import { getPolarShClient } from './polarsh.js';
import type { AiUsageCategory, AiUsageEntryKind, AiUsageResourceType, AiUsageUnit } from './ai_usage_event.js';
import type { AiCreditsData } from './billing.js';

export const AI_USAGE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const AI_USAGE_ITEMIZATION_STARTED_AT = '2026-09-18T19:30:00.000Z';
export const AI_USAGE_MAX_RANGE_DAYS = 31;
const AI_USAGE_DEFAULT_RANGE_DAYS = 30;
const AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS = 32;
const AI_USAGE_PAGE_SIZE = 100;
const AI_USAGE_MAX_POLAR_PAGES = 100;
const AI_USAGE_CACHE_TTL_SECONDS = 120;
const MILLISECONDS_PER_DAY = 86_400_000;

const RECEIPT_CATEGORIES = new Set<string>([
  'tts',
  'ai_chat',
  'ai_agent',
  'memory',
  'clip_recommendation',
  'credit_adjustment',
  'other',
]);

export type AiUsageReceiptCategory = AiUsageCategory | 'uncategorized';

export interface AiUsageWindow {
  from: string;
  to: string;
  timeZone: string;
  startTimestamp: Date;
  endTimestampExclusive: Date;
  days: string[];
}

export type AiUsagePeriodSource = 'subscription' | 'rolling_30_day' | 'custom';

export interface AiUsageBillingPeriod {
  source: AiUsagePeriodSource;
  startsAt: string;
  endsAt: string;
  endExclusive: true;
  from: string;
  to: string;
  totalDayCount: number;
  elapsedDayCount: number;
}

export interface AiUsagePeriodResolution {
  window: AiUsageWindow;
  billingPeriod: AiUsageBillingPeriod;
}

export interface AiUsagePacing {
  status: 'no_usage' | 'within_pace' | 'over_pace' | 'exhausted';
  quotaUsedPercent: number;
  averageDailyCredits: number;
  projectedPeriodCredits: number;
  projectedQuotaUsedPercent: number;
  remainingPeriodDays: number;
  dailyCreditsToLastPeriod: number;
  expectedToExhaustWithinPeriod: boolean;
  estimatedDaysUntilExhaustion: number | null;
  estimatedExhaustionAt: string | null;
}

export interface AiUsageTransaction {
  id: string;
  requestId: string | null;
  occurredAt: string;
  entryKind: AiUsageEntryKind;
  category: AiUsageReceiptCategory;
  operation: string;
  provider: string;
  model: string | null;
  quantity: number | null;
  unit: AiUsageUnit | null;
  credits: number;
  resourceType: AiUsageResourceType | null;
  resourceId: string | null;
  itemized: boolean;
}

export interface AiUsageSummary {
  schemaVersion: typeof AI_USAGE_RECEIPT_SCHEMA_VERSION;
  itemizationStartedAt: string;
  period: {
    from: string;
    to: string;
    timeZone: string;
    dayCount: number;
  };
  totalSpentCredits: number;
  averageDailySpentCredits: number;
  grantedCredits: number;
  netConsumedCredits: number;
  transactionCount: number;
  daily: Array<{ date: string; credits: number; transactionCount: number }>;
  categories: Array<{
    category: AiUsageReceiptCategory;
    credits: number;
    transactionCount: number;
    percentage: number;
  }>;
}

interface PolarUsageEventLike {
  id?: unknown;
  timestamp?: unknown;
  source?: unknown;
  name?: unknown;
  metadata?: unknown;
}

interface PolarEventsPageLike {
  items?: PolarUsageEventLike[];
  pagination?: {
    maxPage?: number;
    hasNextPage?: boolean;
  };
}

interface PolarSubscriptionPeriodLike {
  status?: unknown;
  currentPeriodStart?: unknown;
  currentPeriodEnd?: unknown;
}

interface PolarCustomerStateLike {
  activeSubscriptions?: PolarSubscriptionPeriodLike[];
}

export type PolarUsageEventsList = (request: {
  customerId: string;
  name: string;
  source: 'user';
  startTimestamp: Date;
  endTimestamp: Date;
  page: number;
  limit: number;
  sorting: ['-timestamp'];
}) => Promise<PolarEventsPageLike>;

export type PolarCustomerStateGet = (customerId: string) => Promise<PolarCustomerStateLike>;

export class AiUsageReceiptValidationError extends Error {}
export class AiUsageReceiptLimitError extends Error {}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function assertTimeZone(value: string): string {
  const timeZone = value.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
  } catch {
    throw new AiUsageReceiptValidationError('Invalid timezone');
  }
  return timeZone;
}

function parseDateLabel(value: string, field: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AiUsageReceiptValidationError(`${field} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    throw new AiUsageReceiptValidationError(`${field} is not a valid date`);
  }
  return { year, month, day };
}

function shiftDateLabel(value: string, days: number): string {
  const parsed = parseDateLabel(value, 'date');
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return shifted.toISOString().slice(0, 10);
}

function zonedStartOfDay(value: string, timeZone: string): Date {
  const { year, month, day } = parseDateLabel(value, 'date');
  const wallClockUtc = Date.UTC(year, month - 1, day);
  let guess = wallClockUtc;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const next = wallClockUtc - (representedUtc - guess);
    if (next === guess) break;
    guess = next;
  }

  return new Date(guess);
}

function buildDateLabels(from: string, to: string, maxDays = AI_USAGE_MAX_RANGE_DAYS): string[] {
  const dates: string[] = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    if (dates.length > maxDays) {
      throw new AiUsageReceiptLimitError(`Date range cannot exceed ${maxDays} days`);
    }
    current = shiftDateLabel(current, 1);
  }
  return dates;
}

export function resolveAiUsageWindow(input: {
  from?: string;
  to?: string;
  timeZone?: string;
  now?: Date;
}): AiUsageWindow {
  const timeZone = assertTimeZone(input.timeZone || 'UTC');
  const now = input.now || new Date();
  const today = formatLocalDate(now, timeZone);

  if (Boolean(input.from) !== Boolean(input.to)) {
    throw new AiUsageReceiptValidationError('from and to must be provided together');
  }

  const to = input.to || today;
  const from = input.from || shiftDateLabel(to, -(AI_USAGE_DEFAULT_RANGE_DAYS - 1));
  parseDateLabel(from, 'from');
  parseDateLabel(to, 'to');

  if (from > to) {
    throw new AiUsageReceiptValidationError('from must be on or before to');
  }
  if (to > today) {
    throw new AiUsageReceiptValidationError('to cannot be in the future');
  }

  const days = buildDateLabels(from, to);
  return {
    from,
    to,
    timeZone,
    startTimestamp: zonedStartOfDay(from, timeZone),
    endTimestampExclusive: zonedStartOfDay(shiftDateLabel(to, 1), timeZone),
    days,
  };
}

function billingPeriodFromWindow(window: AiUsageWindow, source: Exclude<AiUsagePeriodSource, 'subscription'>): AiUsageBillingPeriod {
  return {
    source,
    startsAt: window.startTimestamp.toISOString(),
    endsAt: window.endTimestampExclusive.toISOString(),
    endExclusive: true,
    from: window.from,
    to: window.to,
    totalDayCount: window.days.length,
    elapsedDayCount: window.days.length,
  };
}

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findCurrentSubscriptionPeriod(
  subscriptions: PolarSubscriptionPeriodLike[],
  now: Date,
): { start: Date; end: Date } | null {
  const candidates = subscriptions
    .map((subscription) => ({
      status: subscription.status,
      start: validDate(subscription.currentPeriodStart),
      end: validDate(subscription.currentPeriodEnd),
    }))
    .filter((subscription): subscription is { status: unknown; start: Date; end: Date } => (
      Boolean(subscription.start && subscription.end)
      && (subscription.status === 'active' || subscription.status === 'trialing' || subscription.status === undefined)
      && subscription.start!.getTime() <= now.getTime()
      && now.getTime() < subscription.end!.getTime()
      && subscription.start!.getTime() < subscription.end!.getTime()
    ))
    .sort((left, right) => right.start.getTime() - left.start.getTime());

  return candidates[0] ? { start: candidates[0].start, end: candidates[0].end } : null;
}

export async function resolveAiUsagePeriod(input: {
  customerId?: string;
  from?: string;
  to?: string;
  timeZone?: string;
  now?: Date;
  getCustomerState?: PolarCustomerStateGet;
}): Promise<AiUsagePeriodResolution> {
  const timeZone = assertTimeZone(input.timeZone || 'UTC');
  const now = input.now || new Date();

  if (input.from || input.to) {
    const window = resolveAiUsageWindow({
      from: input.from,
      to: input.to,
      timeZone,
      now,
    });
    return { window, billingPeriod: billingPeriodFromWindow(window, 'custom') };
  }

  if (input.customerId) {
    const getState = input.getCustomerState || (async (customerId: string) => {
      const client = await getPolarShClient('resolveAiUsagePeriod');
      return await client.customers.getState({ id: customerId }) as PolarCustomerStateLike;
    });
    const state = await getState(input.customerId);
    const subscription = findCurrentSubscriptionPeriod(state.activeSubscriptions || [], now);

    if (subscription) {
      const from = formatLocalDate(subscription.start, timeZone);
      const periodTo = formatLocalDate(new Date(subscription.end.getTime() - 1), timeZone);
      const elapsedTo = formatLocalDate(
        new Date(Math.max(subscription.start.getTime(), Math.min(now.getTime(), subscription.end.getTime()) - 1)),
        timeZone,
      );
      const days = buildDateLabels(from, elapsedTo, AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS);
      const totalDays = buildDateLabels(from, periodTo, AI_USAGE_MAX_SUBSCRIPTION_DATE_BUCKETS);
      const window: AiUsageWindow = {
        from,
        to: elapsedTo,
        timeZone,
        startTimestamp: subscription.start,
        endTimestampExclusive: subscription.end,
        days,
      };
      return {
        window,
        billingPeriod: {
          source: 'subscription',
          startsAt: subscription.start.toISOString(),
          endsAt: subscription.end.toISOString(),
          endExclusive: true,
          from,
          to: periodTo,
          totalDayCount: totalDays.length,
          elapsedDayCount: days.length,
        },
      };
    }
  }

  const window = resolveAiUsageWindow({ timeZone, now });
  return { window, billingPeriod: billingPeriodFromWindow(window, 'rolling_30_day') };
}

function rounded(value: number, places = 2): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

export function buildAiUsagePacing(input: {
  credits: Pick<AiCreditsData, 'used' | 'limit' | 'balance' | 'available' | 'status'>;
  billingPeriod: AiUsageBillingPeriod;
  now?: Date;
}): AiUsagePacing | null {
  if (input.billingPeriod.source !== 'subscription' || !input.credits.available) return null;

  const now = input.now || new Date();
  const start = new Date(input.billingPeriod.startsAt);
  const end = new Date(input.billingPeriod.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;

  const totalDays = (end.getTime() - start.getTime()) / MILLISECONDS_PER_DAY;
  const elapsedDays = Math.max(
    1,
    Math.min(totalDays, (Math.min(now.getTime(), end.getTime()) - start.getTime()) / MILLISECONDS_PER_DAY),
  );
  const remainingPeriodDays = Math.max(0, (end.getTime() - Math.max(now.getTime(), start.getTime())) / MILLISECONDS_PER_DAY);
  const used = Math.max(0, input.credits.used);
  const limit = Math.max(0, input.credits.limit);
  const balance = Math.max(0, input.credits.balance);
  const averageDailyCredits = used / elapsedDays;
  const projectedPeriodCredits = averageDailyCredits * totalDays;
  const estimatedDays = balance <= 0 ? 0 : averageDailyCredits > 0 ? balance / averageDailyCredits : null;
  const expectedToExhaustWithinPeriod = estimatedDays !== null && estimatedDays < remainingPeriodDays;
  const showExhaustionEstimate = balance <= 0 || expectedToExhaustWithinPeriod;
  const estimatedExhaustionAt = showExhaustionEstimate && estimatedDays !== null
    ? new Date(now.getTime() + estimatedDays * MILLISECONDS_PER_DAY).toISOString()
    : null;

  let status: AiUsagePacing['status'];
  if (input.credits.status === 'exhausted' || balance <= 0) status = 'exhausted';
  else if (used <= 0 || averageDailyCredits <= 0) status = 'no_usage';
  else if (expectedToExhaustWithinPeriod) status = 'over_pace';
  else status = 'within_pace';

  return {
    status,
    quotaUsedPercent: limit > 0 ? rounded((used / limit) * 100) : 0,
    averageDailyCredits: rounded(averageDailyCredits),
    projectedPeriodCredits: Math.round(projectedPeriodCredits),
    projectedQuotaUsedPercent: limit > 0 ? rounded((projectedPeriodCredits / limit) * 100) : 0,
    remainingPeriodDays: rounded(remainingPeriodDays),
    dailyCreditsToLastPeriod: remainingPeriodDays > 0 ? rounded(balance / remainingPeriodDays) : 0,
    expectedToExhaustWithinPeriod,
    estimatedDaysUntilExhaustion: showExhaustionEstimate && estimatedDays !== null ? rounded(estimatedDays, 1) : null,
    estimatedExhaustionAt,
  };
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeText(value: unknown, fallback: string, maxLength = 96): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (!normalized || !/^[a-zA-Z0-9_.:/-]+$/.test(normalized)) return fallback;
  return normalized.slice(0, maxLength);
}

function optionalSafeText(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !/^[a-zA-Z0-9_.:/-]+$/.test(normalized)) return null;
  return normalized.slice(0, maxLength);
}

function receiptCategory(value: unknown): AiUsageReceiptCategory {
  return typeof value === 'string' && RECEIPT_CATEGORIES.has(value)
    ? value as AiUsageCategory
    : 'uncategorized';
}

export function normalizePolarUsageEvent(event: PolarUsageEventLike): AiUsageTransaction | null {
  if (event.name !== 'ai_usage' || event.source !== 'user') return null;
  const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(String(event.timestamp || ''));
  if (Number.isNaN(timestamp.getTime())) return null;
  const metadata = event.metadata && typeof event.metadata === 'object'
    ? event.metadata as Record<string, unknown>
    : {};
  const credits = finiteNumber(metadata.credits);
  if (credits === null) return null;

  const itemized = finiteNumber(metadata.schema_version) === 1;
  const entryId = optionalSafeText(metadata.entry_id) || optionalSafeText(event.id) || `usage-${timestamp.getTime()}`;
  const entryKind: AiUsageEntryKind = metadata.entry_kind === 'adjustment' || credits < 0 ? 'adjustment' : 'usage';
  const unit = metadata.unit === 'characters' || metadata.unit === 'tokens' || metadata.unit === 'minutes'
    ? metadata.unit
    : null;
  const resourceType = metadata.resource_type === 'speech'
    || metadata.resource_type === 'voice_preview'
    || metadata.resource_type === 'llm_generation'
    || metadata.resource_type === 'vod_analysis'
    ? metadata.resource_type
    : null;

  return {
    id: entryId,
    requestId: optionalSafeText(metadata.request_id),
    occurredAt: timestamp.toISOString(),
    entryKind,
    category: receiptCategory(metadata.category),
    operation: safeText(metadata.operation, 'usage'),
    provider: safeText(metadata.provider, 'unknown'),
    model: optionalSafeText(metadata.model),
    quantity: finiteNumber(metadata.quantity),
    unit,
    credits,
    resourceType,
    resourceId: optionalSafeText(metadata.resource_id),
    itemized,
  };
}

function transactionOrder(left: AiUsageTransaction, right: AiUsageTransaction): number {
  const byTimestamp = right.occurredAt.localeCompare(left.occurredAt);
  return byTimestamp || right.id.localeCompare(left.id);
}

export async function fetchAiUsageTransactions(
  customerId: string,
  window: AiUsageWindow,
  listEvents?: PolarUsageEventsList,
): Promise<AiUsageTransaction[]> {
  const list = listEvents || (async (request) => {
    const client = await getPolarShClient('fetchAiUsageTransactions');
    return await client.events.list(request as any) as PolarEventsPageLike;
  });
  const transactions = new Map<string, AiUsageTransaction>();

  for (let page = 1; page <= AI_USAGE_MAX_POLAR_PAGES; page += 1) {
    const result = await list({
      customerId,
      name: 'ai_usage',
      source: 'user',
      startTimestamp: window.startTimestamp,
      endTimestamp: window.endTimestampExclusive,
      page,
      limit: AI_USAGE_PAGE_SIZE,
      sorting: ['-timestamp'],
    });
    const items = Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      const normalized = normalizePolarUsageEvent(item);
      if (normalized) transactions.set(normalized.id, normalized);
    }

    const pagination = result.pagination || {};
    const hasAnotherPage = typeof pagination.maxPage === 'number'
      ? page < pagination.maxPage
      : pagination.hasNextPage === true || items.length === AI_USAGE_PAGE_SIZE;
    if (!hasAnotherPage) {
      return [...transactions.values()].sort(transactionOrder);
    }
  }

  throw new AiUsageReceiptLimitError('Usage history is too large for this date range');
}

export function buildAiUsageSummary(
  transactions: AiUsageTransaction[],
  window: AiUsageWindow,
): AiUsageSummary {
  const daily = new Map(window.days.map((date) => [date, { date, credits: 0, transactionCount: 0 }]));
  const categories = new Map<AiUsageReceiptCategory, { category: AiUsageReceiptCategory; credits: number; transactionCount: number }>();
  let totalSpentCredits = 0;
  let grantedCredits = 0;
  let transactionCount = 0;

  for (const transaction of transactions) {
    if (transaction.credits <= 0 || transaction.entryKind === 'adjustment') {
      if (transaction.credits < 0) grantedCredits += Math.abs(transaction.credits);
      continue;
    }
    totalSpentCredits += transaction.credits;
    transactionCount += 1;
    const date = formatLocalDate(new Date(transaction.occurredAt), window.timeZone);
    const day = daily.get(date);
    if (day) {
      day.credits += transaction.credits;
      day.transactionCount += 1;
    }
    const category = categories.get(transaction.category) || {
      category: transaction.category,
      credits: 0,
      transactionCount: 0,
    };
    category.credits += transaction.credits;
    category.transactionCount += 1;
    categories.set(transaction.category, category);
  }

  const categoryRows = [...categories.values()]
    .sort((left, right) => right.credits - left.credits || left.category.localeCompare(right.category))
    .map((category) => ({
      ...category,
      percentage: totalSpentCredits > 0
        ? Math.round((category.credits / totalSpentCredits) * 10_000) / 100
        : 0,
    }));

  return {
    schemaVersion: AI_USAGE_RECEIPT_SCHEMA_VERSION,
    itemizationStartedAt: AI_USAGE_ITEMIZATION_STARTED_AT,
    period: {
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      dayCount: window.days.length,
    },
    totalSpentCredits,
    averageDailySpentCredits: Math.round((totalSpentCredits / window.days.length) * 100) / 100,
    grantedCredits,
    netConsumedCredits: totalSpentCredits - grantedCredits,
    transactionCount,
    daily: [...daily.values()],
    categories: categoryRows,
  };
}

function encodeCursor(transaction: AiUsageTransaction): string {
  return Buffer.from(JSON.stringify({ id: transaction.id, at: transaction.occurredAt })).toString('base64url');
}

function decodeCursor(value: string): { id: string; at: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.id !== 'string' || typeof parsed.at !== 'string') throw new Error('invalid');
    return { id: parsed.id, at: parsed.at };
  } catch {
    throw new AiUsageReceiptValidationError('Invalid transaction cursor');
  }
}

export function paginateAiUsageTransactions(input: {
  transactions: AiUsageTransaction[];
  category?: string;
  cursor?: string;
  limit?: number;
}): { items: AiUsageTransaction[]; nextCursor: string | null } {
  const category = input.category?.trim();
  if (category && category !== 'uncategorized' && !RECEIPT_CATEGORIES.has(category)) {
    throw new AiUsageReceiptValidationError('Invalid usage category');
  }
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AiUsageReceiptValidationError('limit must be between 1 and 100');
  }
  const filtered = input.transactions
    .filter((transaction) => !category || transaction.category === category)
    .sort(transactionOrder);

  let start = 0;
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    const cursorIndex = filtered.findIndex((transaction) => transaction.id === cursor.id && transaction.occurredAt === cursor.at);
    if (cursorIndex < 0) throw new AiUsageReceiptValidationError('Transaction cursor is no longer available');
    start = cursorIndex + 1;
  }

  const items = filtered.slice(start, start + limit);
  const hasNextPage = start + items.length < filtered.length;
  return {
    items,
    nextCursor: hasNextPage && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
  };
}

export async function getCachedAiUsageTransactions(input: {
  channelID: string;
  customerId: string;
  window: AiUsageWindow;
  listEvents?: PolarUsageEventsList;
}): Promise<AiUsageTransaction[]> {
  const customerHash = createHash('sha256').update(input.customerId).digest('hex').slice(0, 16);
  const timeZoneHash = createHash('sha256').update(input.window.timeZone).digest('hex').slice(0, 12);
  const boundaryHash = createHash('sha256')
    .update(`${input.window.startTimestamp.toISOString()}|${input.window.endTimestampExclusive.toISOString()}`)
    .digest('hex')
    .slice(0, 12);
  const cacheKey = `twitch:${input.channelID}:ai:usage-receipts:v1:${customerHash}:${timeZoneHash}:${boundaryHash}:${input.window.from}:${input.window.to}`;
  let cache: Awaited<ReturnType<typeof getDragonflyClient>> | null = null;

  try {
    cache = await getDragonflyClient('AiUsageReceipts');
    const cached = await cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed)) return parsed as AiUsageTransaction[];
    }
  } catch {
    cache = null;
  }

  const transactions = await fetchAiUsageTransactions(input.customerId, input.window, input.listEvents);
  if (cache) {
    try {
      await cache.set(cacheKey, JSON.stringify(transactions), { EX: AI_USAGE_CACHE_TTL_SECONDS });
    } catch {
      // Polar remains available when the short-lived read cache is unavailable.
    }
  }
  return transactions;
}
