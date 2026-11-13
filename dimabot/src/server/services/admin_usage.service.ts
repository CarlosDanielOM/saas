import type { PipelineStage } from 'mongoose';
import Receipts, { type IAiUsageReceipt } from '../../schemas/ai_usage_receipt.schema.js';
import UsersSchema from '../../schemas/users.schema.js';
import { classifyAdjustment } from '../../utils/ai_usage_classification.js';
import type { AiUsageUnit } from '../../utils/ai_usage_event.js';
import { AI_USAGE_MAX_RANGE_DAYS, type AiUsageReceiptCategory } from '../../utils/ai_usage_receipts.js';
import {
    AdminRequestError, channelLogins, decodeCursor, encodeCursor, queryEnum, queryInt, queryRange, queryString,
    queryToken, queryTwitchId, type TimeRange
} from '../routes/admin_site/shared.js';

/**
 * The owner's cross-channel view of `ai_usage_receipts` (`/admin-site/usage/*`). It only reads what is already
 * in Mongo: no Polar backfill is triggered from here. Shapes follow `admin/src/app/services/usage-api.service.ts`.
 */

export type UsageCategoryKey = Exclude<AiUsageReceiptCategory, 'credit_adjustment'>;
export const USAGE_CATEGORIES: readonly UsageCategoryKey[] = ['tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation', 'other', 'uncategorized'];
const UNITS: readonly AiUsageUnit[] = ['characters', 'tokens', 'minutes'];
const PLAN_TIERS = ['free', 'premium', 'pro'] as const;
type PlanTier = typeof PLAN_TIERS[number];

const DAY = 86_400_000;
export const DEFAULT_RANGE_DAYS = 7;
/** Legacy receipts (from before itemization) have no source; the breakdown and the filter call them this. */
export const UNKNOWN_SOURCE = 'unknown';
export const CREDITS_SORT_MAX_ROWS = 500;
const QUERY_MS = 8000;
const LIMITS = { model: 20, source: 12, channel: 25, actor: 25 } as const;

export interface UsageFilterInput {
    range: TimeRange;
    channel?: string;
    actor?: string;
    category?: UsageCategoryKey;
    provider?: string;
    model?: string;
    source?: string;
}

export interface UsageActor { id: string | null; login: string | null; name: string | null }
export interface UsageTotals { count: number; credits: number; providerUSD: number; providerKnown: number }

export interface UsageSummary {
    from: string;
    to: string;
    totals: UsageTotals & { channels: number; chatters: number; withActor: number };
    granted: number;
    byCategory: Array<UsageTotals & { category: UsageCategoryKey }>;
    byModel: Array<UsageTotals & { category: UsageCategoryKey; provider: string; model: string | null }>;
    bySource: Array<UsageTotals & { category: UsageCategoryKey; source: string }>;
    byChannel: Array<UsageTotals & { channelID: string; channel: string | null; planTier: PlanTier | null }>;
    byActor: Array<UsageTotals & { actor: UsageActor }>;
    daily: Array<{ date: string; count: number; credits: number; providerUSD: number }>;
}

export interface UsageTransaction {
    id: string;
    at: string;
    channelID: string;
    channel: string | null;
    entryKind: 'usage' | 'adjustment';
    category: UsageCategoryKey | 'credit_adjustment';
    operation: string;
    source: string | null;
    adjustmentType: string | null;
    provider: string;
    model: string | null;
    voice: string | null;
    quantity: number | null;
    unit: AiUsageUnit | null;
    credits: number;
    providerUSD: number | null;
    actor: UsageActor | null;
}

export interface UsageTransactionPage { items: UsageTransaction[]; nextCursor: string | null }

export type UsageEntryKindFilter = 'usage' | 'adjustment' | 'all';
export type UsageSort = 'newest' | 'credits';
export type UsagePosition = { kind: 'time'; at: Date; id: string } | { kind: 'skip'; skip: number };
export interface UsageTransactionInput extends UsageFilterInput {
    entryKind: UsageEntryKindFilter;
    sort: UsageSort;
    limit: number;
    position?: UsagePosition;
}

// ---- Query parsing (pure). ----

export function parseUsageFilters(query: Record<string, unknown>, now = new Date()): UsageFilterInput {
    return {
        range: queryRange(query, DEFAULT_RANGE_DAYS, AI_USAGE_MAX_RANGE_DAYS, now),
        channel: queryTwitchId(query.channel, 'channel'),
        actor: queryTwitchId(query.actor, 'actor'),
        category: queryEnum(query.category, 'category', USAGE_CATEGORIES),
        provider: queryToken(query.provider, 'provider'),
        model: queryToken(query.model, 'model', 160),
        source: queryToken(query.source, 'source')
    };
}

const CREDITS_CURSOR_TAG = 'credits';

/** The "most expensive first" list pages by offset; the cursor carries it so the client treats both sorts alike. */
export function encodeSkipCursor(skip: number): string {
    return Buffer.from(JSON.stringify([CREDITS_CURSOR_TAG, skip])).toString('base64url');
}

export function decodeSkipCursor(value: unknown): number | undefined {
    const text = queryString(value, 'cursor');
    if (text === undefined) return undefined;
    try {
        if (text.length > 100) throw new Error('long');
        const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== CREDITS_CURSOR_TAG
            || !Number.isSafeInteger(parsed[1]) || parsed[1] < 1 || parsed[1] >= CREDITS_SORT_MAX_ROWS) throw new Error('shape');
        return parsed[1];
    } catch {
        throw new AdminRequestError('Invalid cursor');
    }
}

export function parseUsageTransactionQuery(query: Record<string, unknown>, now = new Date()): UsageTransactionInput {
    const filters = parseUsageFilters(query, now);
    const entryKind = queryEnum(query.entryKind, 'entryKind', ['usage', 'adjustment', 'all'] as const, 'usage');
    const sort = queryEnum(query.sort, 'sort', ['newest', 'credits'] as const, 'newest');
    const limit = queryInt(query.limit, 'limit', 40, 1, 100);
    let position: UsagePosition | undefined;
    if (sort === 'credits') {
        const skip = decodeSkipCursor(query.cursor);
        if (skip !== undefined) position = { kind: 'skip', skip };
    } else {
        const cursor = decodeCursor(query.cursor);
        if (cursor) position = { kind: 'time', at: cursor.at, id: cursor.id };
    }
    return { ...filters, entryKind, sort, limit, position };
}

// ---- Mongo filters (pure). ----

/**
 * Index use: `channel` → `{channelID, customerId, occurredAt, entryId}` (customerId unconstrained; one per
 * channel in practice), `actor` → partial `{actorId, occurredAt, entryId}` (the `$type` term lets the planner
 * use the partial index), `category` → `{category, occurredAt, entryId}`, otherwise `{occurredAt, entryId}`.
 * provider/model/source have no index of their own and are filtered inside the bounded time window.
 */
export function usageMatch(filters: UsageFilterInput, now: Date): Record<string, unknown> {
    const match: Record<string, unknown> = {
        occurredAt: { $gte: filters.range.from, $lt: filters.range.to },
        // Rows past their plan's retention are hidden even before the TTL monitor deletes them.
        expiresAt: { $gt: now }
    };
    if (filters.channel) match.channelID = filters.channel;
    if (filters.actor) match.actorId = { $eq: filters.actor, $type: 'string' };
    if (filters.category) match.category = filters.category;
    if (filters.provider) match.provider = filters.provider;
    if (filters.model) match.model = filters.model;
    if (filters.source) match.source = filters.source === UNKNOWN_SOURCE ? { $in: [null, UNKNOWN_SOURCE] } : filters.source;
    return match;
}

/** Grants belong to a channel, not to a chatter, feature or model, so only the channel and the window narrow them. */
export function grantMatch(filters: UsageFilterInput, now: Date): Record<string, unknown> {
    return {
        occurredAt: { $gte: filters.range.from, $lt: filters.range.to },
        expiresAt: { $gt: now },
        ...(filters.channel ? { channelID: filters.channel } : {}),
        credits: { $lt: 0 }
    };
}

export function transactionMatch(input: UsageTransactionInput, now: Date): Record<string, unknown> {
    const match = usageMatch(input, now);
    if (input.entryKind !== 'all') match.entryKind = input.entryKind;
    if (input.position?.kind === 'time') {
        const { at, id } = input.position;
        match.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, entryId: { $lt: id } }];
    }
    return match;
}

// ---- Summary. ----

const known = { $isNumber: '$costUsd' };
// Usage credits mirror the channel dashboard: only positive charges count as spend.
const totalsGroup = {
    count: { $sum: 1 },
    credits: { $sum: { $cond: [{ $gt: ['$credits', 0] }, '$credits', 0] } },
    providerUSD: { $sum: { $cond: [known, '$costUsd', 0] } },
    providerKnown: { $sum: { $cond: [known, 1, 0] } }
};
const biggestFirst = { $sort: { credits: -1, count: -1, _id: 1 } } as PipelineStage.Sort;
const hasActor = { actorId: { $type: 'string' } };

export function summaryPipeline(filters: UsageFilterInput, now: Date): PipelineStage[] {
    return [
        { $match: { ...usageMatch(filters, now), entryKind: 'usage' } },
        { $facet: {
            totals: [{ $group: { _id: null, ...totalsGroup } }],
            channels: [{ $group: { _id: '$channelID' } }, { $count: 'n' }],
            chatters: [{ $match: hasActor }, { $group: { _id: '$actorId' } }, { $count: 'n' }],
            withActor: [{ $match: hasActor }, { $count: 'n' }],
            byCategory: [{ $group: { _id: '$category', ...totalsGroup } }, biggestFirst],
            byModel: [{ $group: { _id: { category: '$category', provider: '$provider', model: { $ifNull: ['$model', null] } }, ...totalsGroup } }, biggestFirst, { $limit: LIMITS.model }],
            bySource: [{ $group: { _id: { category: '$category', source: { $ifNull: ['$source', UNKNOWN_SOURCE] } }, ...totalsGroup } }, biggestFirst, { $limit: LIMITS.source }],
            byChannel: [{ $group: { _id: '$channelID', ...totalsGroup } }, biggestFirst, { $limit: LIMITS.channel }],
            byActor: [{ $match: hasActor }, { $group: { _id: '$actorId', ...totalsGroup,
                // The newest receipt carries the chatter's current name.
                latest: { $top: { sortBy: { occurredAt: -1 }, output: { login: '$actorLogin', name: '$actorName' } } } } },
            biggestFirst, { $limit: LIMITS.actor }],
            daily: [{ $group: { _id: { $dateToString: { date: '$occurredAt', format: '%Y-%m-%d', timezone: 'UTC' } },
                count: { $sum: 1 }, credits: totalsGroup.credits, providerUSD: totalsGroup.providerUSD } }]
        } }
    ] as PipelineStage[];
}

/** UTC dates touched by [from, to), oldest first. */
export function utcDays(range: TimeRange): string[] {
    const days: string[] = [];
    const last = new Date(range.to.getTime() - 1).toISOString().slice(0, 10);
    for (let at = Date.parse(range.from.toISOString().slice(0, 10)); ; at += DAY) {
        const date = new Date(at).toISOString().slice(0, 10);
        days.push(date);
        if (date >= last) return days;
    }
}

/** Float sums of tiny provider costs drift (0.1 + 0.2); a hundred-millionth of a dollar is below any real price. */
export const roundUSD = (value: number): number => Math.round((Number(value) || 0) * 1e8) / 1e8;

export const safeCategory = (value: unknown): UsageCategoryKey =>
    USAGE_CATEGORIES.includes(value as UsageCategoryKey) ? value as UsageCategoryKey : 'uncategorized';

const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

interface TotalsRow { count?: number; credits?: number; providerUSD?: number; providerKnown?: number }
const totalsOf = (row: TotalsRow | undefined): UsageTotals => ({
    count: row?.count || 0, credits: row?.credits || 0, providerUSD: roundUSD(row?.providerUSD || 0), providerKnown: row?.providerKnown || 0
});

/**
 * Categories are merged after mapping so a stray stored value cannot split "uncategorized" in two;
 * biggest first with a stable tie-break.
 */
function mergeCategories(rows: Array<TotalsRow & { _id: unknown }>) {
    const merged = new Map<UsageCategoryKey, UsageTotals>();
    for (const row of rows) {
        const key = safeCategory(row._id);
        const current = merged.get(key) || totalsOf(undefined);
        const next = totalsOf(row);
        merged.set(key, { count: current.count + next.count, credits: current.credits + next.credits,
            providerUSD: roundUSD(current.providerUSD + next.providerUSD), providerKnown: current.providerKnown + next.providerKnown });
    }
    return [...merged].map(([category, totals]) => ({ ...totals, category }))
        .sort((a, b) => b.credits - a.credits || b.count - a.count || a.category.localeCompare(b.category));
}

export interface SummaryFacets {
    totals: TotalsRow[];
    channels: Array<{ n: number }>;
    chatters: Array<{ n: number }>;
    withActor: Array<{ n: number }>;
    byCategory: Array<TotalsRow & { _id: unknown }>;
    byModel: Array<TotalsRow & { _id: { category?: unknown; provider?: unknown; model?: unknown } }>;
    bySource: Array<TotalsRow & { _id: { category?: unknown; source?: unknown } }>;
    byChannel: Array<TotalsRow & { _id: string }>;
    byActor: Array<TotalsRow & { _id: string; latest?: { login?: unknown; name?: unknown } }>;
    daily: Array<{ _id: string; count: number; credits: number; providerUSD: number }>;
}

export function shapeSummary(input: {
    range: TimeRange; facets: SummaryFacets; granted: number;
    logins: Map<string, string>; tiers: Map<string, PlanTier>;
}): UsageSummary {
    const { facets } = input;
    const daily = new Map(facets.daily.map(row => [row._id, row]));
    return {
        from: input.range.from.toISOString(),
        to: input.range.to.toISOString(),
        totals: { ...totalsOf(facets.totals[0]), channels: facets.channels[0]?.n || 0, chatters: facets.chatters[0]?.n || 0,
            withActor: facets.withActor?.[0]?.n || 0 },
        granted: input.granted,
        byCategory: mergeCategories(facets.byCategory),
        byModel: facets.byModel.map(row => ({ ...totalsOf(row), category: safeCategory(row._id.category),
            provider: text(row._id.provider) || 'unknown', model: text(row._id.model) })),
        bySource: facets.bySource.map(row => ({ ...totalsOf(row), category: safeCategory(row._id.category),
            source: text(row._id.source) || UNKNOWN_SOURCE })),
        byChannel: facets.byChannel.map(row => ({ ...totalsOf(row), channelID: row._id,
            channel: input.logins.get(row._id) || null, planTier: input.tiers.get(row._id) || null })),
        byActor: facets.byActor.map(row => ({ ...totalsOf(row),
            actor: { id: row._id, login: text(row.latest?.login), name: text(row.latest?.name) } })),
        daily: utcDays(input.range).map(date => {
            const row = daily.get(date);
            return { date, count: row?.count || 0, credits: row?.credits || 0, providerUSD: roundUSD(row?.providerUSD || 0) };
        })
    };
}

/** The current plan of each channel's owner; channels without an account here are left out. */
export async function channelPlanTiers(channelIDs: string[]): Promise<Map<string, PlanTier>> {
    const tiers = new Map<string, PlanTier>();
    if (!channelIDs.length) return tiers;
    const owners = await UsersSchema.find({ accounts: { $elemMatch: { type: 'twitch', id: { $in: channelIDs } } } })
        .select('accounts.type accounts.id plan_tier').maxTimeMS(5000).lean();
    for (const owner of owners) {
        const tier: PlanTier = PLAN_TIERS.includes(owner.plan_tier) ? owner.plan_tier : 'free';
        for (const account of owner.accounts || []) {
            if (account.type === 'twitch' && channelIDs.includes(String(account.id))) tiers.set(String(account.id), tier);
        }
    }
    return tiers;
}

export async function usageSummary(filters: UsageFilterInput, now = new Date()): Promise<UsageSummary> {
    const [facetRows, grantRows] = await Promise.all([
        Receipts.aggregate<SummaryFacets>(summaryPipeline(filters, now)).option({ maxTimeMS: QUERY_MS }).exec(),
        Receipts.aggregate<{ granted: number }>([
            { $match: grantMatch(filters, now) },
            { $group: { _id: null, granted: { $sum: { $multiply: ['$credits', -1] } } } }
        ]).option({ maxTimeMS: QUERY_MS }).exec()
    ]);
    const facets = facetRows[0];
    const channelIDs = facets.byChannel.map(row => row._id);
    const [logins, tiers] = await Promise.all([channelLogins(channelIDs), channelPlanTiers(channelIDs)]);
    return shapeSummary({ range: filters.range, facets, granted: grantRows[0]?.granted || 0, logins, tiers });
}

// ---- Transactions. ----

/** Everything a list row needs and nothing else (no Polar customer id, request or resource ids). */
const TRANSACTION_FIELDS = 'entryId occurredAt channelID entryKind category operation source adjustmentType provider model voice quantity unit credits costUsd actorId actorLogin actorName';
type TransactionDoc = Pick<IAiUsageReceipt, 'entryId' | 'occurredAt' | 'channelID' | 'entryKind' | 'category' | 'operation' | 'source'
    | 'adjustmentType' | 'provider' | 'model' | 'voice' | 'quantity' | 'unit' | 'credits' | 'costUsd' | 'actorId' | 'actorLogin' | 'actorName'>;

export function shapeTransaction(doc: TransactionDoc, logins: Map<string, string>): UsageTransaction {
    const adjustment = doc.entryKind === 'adjustment';
    const actor = { id: text(doc.actorId), login: text(doc.actorLogin), name: text(doc.actorName) };
    return {
        id: doc.entryId,
        at: new Date(doc.occurredAt).toISOString(),
        channelID: doc.channelID,
        channel: logins.get(doc.channelID) || null,
        entryKind: adjustment ? 'adjustment' : 'usage',
        category: adjustment && doc.category === 'credit_adjustment' ? 'credit_adjustment' : safeCategory(doc.category),
        operation: doc.operation,
        source: text(doc.source),
        adjustmentType: text(doc.adjustmentType) || classifyAdjustment(doc),
        provider: doc.provider,
        model: text(doc.model),
        voice: text(doc.voice),
        quantity: finite(doc.quantity),
        unit: UNITS.includes(doc.unit as AiUsageUnit) ? doc.unit as AiUsageUnit : null,
        credits: finite(doc.credits) || 0,
        providerUSD: finite(doc.costUsd),
        actor: actor.id || actor.login || actor.name ? actor : null
    };
}

export async function usageTransactions(input: UsageTransactionInput, now = new Date()): Promise<UsageTransactionPage> {
    const match = transactionMatch(input, now);
    if (input.sort === 'credits') {
        const skip = input.position?.kind === 'skip' ? input.position.skip : 0;
        const limit = Math.min(input.limit, CREDITS_SORT_MAX_ROWS - skip);
        // Top-k sort over the window; ties fall back to the newest-first order so pages never reshuffle.
        const docs = await Receipts.find(match).sort({ credits: -1, occurredAt: -1, entryId: -1 }).skip(skip).limit(limit + 1)
            .select(TRANSACTION_FIELDS).maxTimeMS(QUERY_MS).lean<TransactionDoc[]>().exec();
        const page = docs.slice(0, limit);
        const more = docs.length > limit && skip + page.length < CREDITS_SORT_MAX_ROWS;
        return finish(page, more ? encodeSkipCursor(skip + page.length) : null);
    }
    const docs = await Receipts.find(match).sort({ occurredAt: -1, entryId: -1 }).limit(input.limit + 1)
        .select(TRANSACTION_FIELDS).maxTimeMS(QUERY_MS).lean<TransactionDoc[]>().exec();
    const page = docs.slice(0, input.limit);
    const last = page.at(-1);
    return finish(page, docs.length > input.limit && last ? encodeCursor({ at: new Date(last.occurredAt), id: last.entryId }) : null);
}

async function finish(page: TransactionDoc[], nextCursor: string | null): Promise<UsageTransactionPage> {
    const logins = await channelLogins(page.map(doc => doc.channelID));
    return { items: page.map(doc => shapeTransaction(doc, logins)), nextCursor };
}
