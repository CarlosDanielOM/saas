import { Types, type PipelineStage } from 'mongoose';
import { ActivityLog } from '../../schemas/activity_log.schema.js';
import AiUsageReceiptSchema from '../../schemas/ai_usage_receipt.schema.js';
import { CreditGiftSchema } from '../../schemas/credit_gift.schema.js';
import { DomainEventDeliverySchema } from '../../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../../schemas/domain_event.schema.js';
import { ModerationDecision } from '../../schemas/moderation_decision.schema.js';
import { SITE_AGENT_KEYS } from '../../site_agent/config.js';
import { SiteAgentTurnLog } from '../../site_agent/turn_log.schema.js';
import { DOCS_ASSISTANT_KEYS } from '../../utils/ai/docs_assistant/docs_assistant.js';
import { AI_USAGE_BACKFILL_DEAD_KEY } from '../../utils/ai_usage_backfill_queue.js';
import { getDragonflyClient } from '../../utils/databases/dragonfly.database.js';
import { MODERATION_RETENTION_DAYS } from '../../utils/moderation/advanced.js';
import { channelLogins as realChannelLogins, creditsToUSD } from '../routes/admin_site/shared.js';
import { listFeed as realListFeed, summarizeFeed as realSummarizeFeed, type FeedItem, type FeedKindCount } from './admin_feed/index.js';
import { moderationReviewCountsCached } from './moderation_review.service.js';

/**
 * `GET /admin-site/overview`: what is happening across all channels, what it costs, and what needs the
 * owner. Mirrors `admin/src/app/services/overview-api.service.ts` (the contract).
 *
 * Each part reads its own store with its own timeout. A part that fails or is slow is listed in `partial`
 * and contributes zeros, so the page always answers. The whole answer is cached for a few seconds: the page
 * refreshes itself and several open tabs must not multiply the load.
 */

export const SPEND_FEATURES = ['voice', 'ai_chat', 'memory', 'protection', 'assistant', 'docs', 'other'] as const;
export type SpendFeature = typeof SPEND_FEATURES[number];
export type AttentionKey = 'verdicts_waiting' | 'failed_24h' | 'dead_deliveries' | 'usage_import_stuck'
    | 'polar_unsent' | 'gifts_need_support' | 'credits_exhausted';
/** In the order the contract lists them; `partial` keeps this order. */
export const OVERVIEW_PARTS = ['feed', 'usage', 'decisions', 'assistant', 'docs', 'attention'] as const;
export type OverviewPart = typeof OVERVIEW_PARTS[number];

export interface OverviewFeature { feature: SpendFeature; count: number; failed: number; credits: number; providerUSD: number | null }
export interface OverviewDay { date: string; events: number; problems: number; credits: number; providerUSD: number }
export interface OverviewChannel { channelID: string; channel: string | null; events: number; problems: number; credits: number }

export interface AdminOverview {
    generatedAt: string;
    day: { from: string; to: string; kinds: FeedKindCount[]; activeChannels: number; credits: number; providerUSD: number };
    daily: OverviewDay[];
    features: OverviewFeature[];
    topChannels: OverviewChannel[];
    attention: Array<{ key: AttentionKey; count: number }>;
    recent: FeedItem[];
    partial: string[];
}

const DAY_MS = 86_400_000;
export const DAILY_DAYS = 14;
export const FEATURE_DAYS = 7;
export const TOP_CHANNELS = 8;
export const RECENT_ITEMS = 8;
const DEAD_DELIVERY_DAYS = 30;
const QUERY_MS = 4000;
const PART_TIMEOUT_MS = 5000;
const CACHE_MS = 15_000;
const PROBLEM_OUTCOMES = ['skipped', 'blocked', 'failed'];
/** A chat protection review charged to a channel is both a decision and a receipt: the decision is counted. */
export const PROTECTION_OPERATION = 'contextual_moderation';
/** Decision statuses that mean the AI did look at the message (or the review is still running). */
const REVIEWED_STATUSES = ['pending', 'completed', 'uncertain', 'matched'];

/** The time windows every part reads. `days` are the 14 UTC days, oldest first, the last one being today. */
export interface OverviewWindows {
    now: Date;
    /** The last 24 hours. */
    dayFrom: Date;
    /** Start of the oldest of the 14 UTC days. */
    dailyFrom: Date;
    /** Start of the oldest of the last 7 UTC days (features). */
    weekFrom: Date;
    days: string[];
}

export function overviewWindows(now: Date): OverviewWindows {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const days = Array.from({ length: DAILY_DAYS }, (_, index) => new Date(today - (DAILY_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10));
    return {
        now,
        dayFrom: new Date(now.getTime() - DAY_MS),
        dailyFrom: new Date(today - (DAILY_DAYS - 1) * DAY_MS),
        weekFrom: new Date(today - (FEATURE_DAYS - 1) * DAY_MS),
        days
    };
}

/** What one store adds to the overview. Every field is optional; missing means nothing from this store. */
export interface OverviewFragment {
    daily?: Record<string, Partial<Omit<OverviewDay, 'date'>>>;
    /** The last 24 hours, by channel id. */
    channels?: Record<string, Partial<Omit<OverviewChannel, 'channelID' | 'channel'>>>;
    /** The last 24 hours. */
    day?: { credits?: number; providerUSD?: number };
    features?: Partial<Record<SpendFeature, Partial<Omit<OverviewFeature, 'feature'>>>>;
    attention?: Partial<Record<AttentionKey, number>>;
}

export type OverviewLoader = (windows: OverviewWindows) => Promise<OverviewFragment>;
export interface OverviewLoaders {
    /** Activity log + journaled Twitch events (reported as 'feed' when they fail: they are the feed's stores). */
    activity: OverviewLoader;
    usage: OverviewLoader;
    decisions: OverviewLoader;
    assistant: OverviewLoader;
    docs: OverviewLoader;
    attention: OverviewLoader;
}
const LOADER_PARTS: Record<keyof OverviewLoaders, OverviewPart> = {
    activity: 'feed', usage: 'usage', decisions: 'decisions', assistant: 'assistant', docs: 'docs', attention: 'attention'
};

export interface OverviewDeps {
    listFeed: typeof realListFeed;
    summarizeFeed: typeof realSummarizeFeed;
    channelLogins: (ids: Iterable<string>) => Promise<Map<string, string>>;
    loaders: OverviewLoaders;
    now: () => Date;
    timeoutMs: number;
    cacheMs: number;
}

// ---- Assembly (pure) ----

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const roundUSD = (value: number): number => Math.round(num(value) * 1e8) / 1e8;

export interface OverviewInputs {
    windows: OverviewWindows;
    kinds: FeedKindCount[];
    recent: FeedItem[];
    fragments: OverviewFragment[];
    partial: Set<OverviewPart>;
    /** Channel id → login; ids without one get `channel: null`. */
    logins?: Map<string, string>;
}

/** Channels with any row in the last 24 hours, busiest first (ties: more problems, then id). */
export function rankChannels(fragments: OverviewFragment[]): OverviewChannel[] {
    const channels = new Map<string, OverviewChannel>();
    for (const fragment of fragments) {
        for (const [channelID, counts] of Object.entries(fragment.channels || {})) {
            if (!/^\d{1,20}$/.test(channelID)) continue;
            const row = channels.get(channelID) || { channelID, channel: null, events: 0, problems: 0, credits: 0 };
            row.events += num(counts.events);
            row.problems += num(counts.problems);
            row.credits += num(counts.credits);
            channels.set(channelID, row);
        }
    }
    return [...channels.values()]
        .filter(row => row.events > 0 || row.credits > 0)
        .sort((a, b) => b.events - a.events || b.problems - a.problems || a.channelID.localeCompare(b.channelID));
}

const spendUSD = (row: OverviewFeature) => creditsToUSD(row.credits) + (row.providerUSD ?? 0);

export function buildOverview(input: OverviewInputs): AdminOverview {
    const { windows, fragments } = input;
    const daily = new Map(windows.days.map(date => [date, { date, events: 0, problems: 0, credits: 0, providerUSD: 0 }]));
    const features = new Map(SPEND_FEATURES.map(feature => [feature, { feature, count: 0, failed: 0, credits: 0, providerUSD: null as number | null }]));
    const attention = new Map<AttentionKey, number>();
    let credits = 0;
    let providerUSD = 0;
    for (const fragment of fragments) {
        for (const [date, counts] of Object.entries(fragment.daily || {})) {
            const row = daily.get(date);
            if (!row) continue;
            row.events += num(counts.events);
            row.problems += num(counts.problems);
            row.credits += num(counts.credits);
            row.providerUSD += num(counts.providerUSD);
        }
        for (const [feature, counts] of Object.entries(fragment.features || {}) as [SpendFeature, Partial<OverviewFeature>][]) {
            const row = features.get(feature);
            if (!row || !counts) continue;
            row.count += num(counts.count);
            row.failed += num(counts.failed);
            row.credits += num(counts.credits);
            if (typeof counts.providerUSD === 'number') row.providerUSD = (row.providerUSD ?? 0) + num(counts.providerUSD);
        }
        for (const [key, count] of Object.entries(fragment.attention || {}) as [AttentionKey, number][]) {
            attention.set(key, (attention.get(key) || 0) + num(count));
        }
        credits += num(fragment.day?.credits);
        providerUSD += num(fragment.day?.providerUSD);
    }
    const failed24h = input.kinds.reduce((sum, kind) => sum + num(kind.failed), 0);
    if (failed24h) attention.set('failed_24h', failed24h);

    const ranked = rankChannels(fragments);
    const logins = input.logins || new Map<string, string>();
    const attentionOrder: AttentionKey[] = ['verdicts_waiting', 'failed_24h', 'dead_deliveries', 'usage_import_stuck', 'polar_unsent', 'gifts_need_support', 'credits_exhausted'];
    return {
        generatedAt: windows.now.toISOString(),
        day: {
            from: windows.dayFrom.toISOString(),
            to: windows.now.toISOString(),
            kinds: input.kinds,
            activeChannels: ranked.length,
            credits,
            providerUSD: roundUSD(providerUSD)
        },
        daily: [...daily.values()].map(row => ({ ...row, providerUSD: roundUSD(row.providerUSD) })),
        features: [...features.values()]
            .map(row => ({ ...row, providerUSD: row.providerUSD === null ? null : roundUSD(row.providerUSD) }))
            .sort((a, b) => spendUSD(b) - spendUSD(a) || b.count - a.count || SPEND_FEATURES.indexOf(a.feature) - SPEND_FEATURES.indexOf(b.feature)),
        topChannels: ranked.slice(0, TOP_CHANNELS).map(row => ({ ...row, channel: logins.get(row.channelID) || null })),
        attention: attentionOrder.filter(key => (attention.get(key) || 0) > 0).map(key => ({ key, count: attention.get(key)! })),
        recent: input.recent.slice(0, RECENT_ITEMS),
        partial: OVERVIEW_PARTS.filter(part => input.partial.has(part))
    };
}

// ---- Running the parts ----

function withTimeout<T>(work: () => Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        timer.unref?.();
        Promise.resolve().then(work).then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

function warnPart(part: string, error: unknown): void {
    // Server log only, and only the message: driver errors never reach the browser.
    console.warn(`[admin-overview] ${part} unavailable:`, error instanceof Error ? error.message : 'unknown error');
}

export async function computeOverview(deps: Omit<OverviewDeps, 'cacheMs'>): Promise<AdminOverview> {
    const windows = overviewWindows(deps.now());
    const partial = new Set<OverviewPart>();
    const run = async <T>(part: OverviewPart, label: string, work: () => Promise<T>): Promise<T | null> => {
        try {
            return await withTimeout(work, deps.timeoutMs, label);
        } catch (error) {
            partial.add(part);
            warnPart(label, error);
            return null;
        }
    };
    const feedFilters = { from: windows.dayFrom, to: windows.now };
    const [summary, page, ...fragments] = await Promise.all([
        run('feed', 'feed summary', () => deps.summarizeFeed(feedFilters)),
        run('feed', 'feed list', () => deps.listFeed(feedFilters, undefined, RECENT_ITEMS)),
        ...(Object.keys(LOADER_PARTS) as (keyof OverviewLoaders)[]).map(name => run(LOADER_PARTS[name], name, () => deps.loaders[name](windows)))
    ]);
    // The feed answers without the stores it could not read; its counts are then incomplete.
    if (summary?.partial.length || page?.partial.length) partial.add('feed');
    const input: OverviewInputs = {
        windows,
        kinds: summary?.kinds || [],
        recent: page?.items || [],
        fragments: fragments.filter((fragment): fragment is OverviewFragment => !!fragment),
        partial
    };
    const top = rankChannels(input.fragments).slice(0, TOP_CHANNELS).map(row => row.channelID);
    if (top.length) {
        // Names are a nicety: without them the page shows ids, and the overview still answers.
        input.logins = await withTimeout(() => deps.channelLogins(top), deps.timeoutMs, 'channel names')
            .catch(error => { warnPart('channel names', error); return new Map<string, string>(); });
    }
    return buildOverview(input);
}

/** One overview at a time, reused for `cacheMs`; callers that arrive while it is being built share it. */
export function createOverviewService(overrides: Partial<OverviewDeps> = {}) {
    const deps: OverviewDeps = {
        listFeed: realListFeed,
        summarizeFeed: realSummarizeFeed,
        channelLogins: realChannelLogins,
        loaders: overviewLoaders,
        now: () => new Date(),
        timeoutMs: PART_TIMEOUT_MS,
        cacheMs: CACHE_MS,
        ...overrides
    };
    let cached: { at: number; value: AdminOverview } | null = null;
    let building: Promise<AdminOverview> | null = null;
    return {
        get(): Promise<AdminOverview> {
            const now = deps.now().getTime();
            if (cached && now - cached.at < deps.cacheMs) return Promise.resolve(cached.value);
            if (building) return building;
            building = computeOverview(deps)
                .then(value => { cached = { at: deps.now().getTime(), value }; return value; })
                .finally(() => { building = null; });
            return building;
        },
        clear(): void { cached = null; }
    };
}

// ---- The stores ----

const utcDay = (field: unknown) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'UTC' } });
const oidAt = (date: Date) => Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
const sumIf = (condition: unknown, value: unknown = 1) => ({ $sum: { $cond: [condition, value, 0] } });
const toRecord = <T>(rows: Array<{ _id: unknown } & T>): Record<string, T> =>
    Object.fromEntries(rows.filter(row => typeof row._id === 'string' && row._id).map(({ _id, ...rest }) => [_id as string, rest as T]));

/**
 * Activity log and journaled Twitch events. Daily totals and problems are counted from the indexes
 * alone (`{at, _id}`, the partial `problems_at`, and `{topic, _id}` whose ObjectId carries the journal
 * time); the 24-hour channel split reads the last day's rows.
 */
export async function loadActivityFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const range = { $gte: w.dailyFrom, $lte: w.now };
    const [events, problems, journal, activityChannels, journalChannels, voiceFailed] = await Promise.all([
        ActivityLog.aggregate<{ _id: string; n: number }>([
            { $match: { at: range } }, { $group: { _id: utcDay('$at'), n: { $sum: 1 } } }
        ]).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.aggregate<{ _id: string; n: number }>([
            { $match: { at: range, outcome: { $in: PROBLEM_OUTCOMES } } }, { $group: { _id: utcDay('$at'), n: { $sum: 1 } } }
        ]).hint('problems_at').option({ maxTimeMS: QUERY_MS }),
        DomainEventSchema.aggregate<{ _id: string; n: number }>([
            { $match: { topic: 'channel', _id: { $gte: oidAt(w.dailyFrom) } } },
            { $group: { _id: utcDay({ $toDate: '$_id' }), n: { $sum: 1 } } }
        ]).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.aggregate<{ _id: string; events: number; problems: number }>([
            { $match: { at: { $gte: w.dayFrom, $lte: w.now }, channelID: { $gt: '' } } },
            { $group: { _id: '$channelID', events: { $sum: 1 }, problems: sumIf({ $in: ['$outcome', PROBLEM_OUTCOMES] }) } }
        ]).option({ maxTimeMS: QUERY_MS }),
        DomainEventSchema.aggregate<{ _id: string; events: number }>([
            { $match: { topic: 'channel', _id: { $gte: oidAt(w.dayFrom) } } },
            { $group: { _id: '$channelID', events: { $sum: 1 } } }
        ]).option({ maxTimeMS: QUERY_MS }),
        ActivityLog.countDocuments({ kind: 'voice', at: { $gte: w.weekFrom, $lte: w.now }, outcome: 'failed' }).maxTimeMS(QUERY_MS)
    ]);
    const daily: NonNullable<OverviewFragment['daily']> = {};
    const add = (date: string, field: 'events' | 'problems', n: number) => { (daily[date] ||= {})[field] = num(daily[date][field]) + n; };
    for (const row of events) add(row._id, 'events', row.n);
    for (const row of journal) add(row._id, 'events', row.n);
    for (const row of problems) add(row._id, 'problems', row.n);
    const channels: NonNullable<OverviewFragment['channels']> = toRecord(activityChannels);
    for (const row of journalChannels) {
        if (typeof row._id !== 'string' || !row._id) continue;
        const target = channels[row._id] ||= {};
        target.events = num(target.events) + row.events;
    }
    return { daily, channels, features: { voice: { failed: voiceFailed } } };
}

export const receiptFeature = (category: unknown): SpendFeature =>
    category === 'tts' ? 'voice' : category === 'ai_chat' ? 'ai_chat' : category === 'memory' ? 'memory' : 'other';

/** AI usage receipts over the 14 days (`{occurredAt, entryId}` index). */
export async function loadUsageFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const notProtection = { $ne: ['$operation', PROTECTION_OPERATION] };
    const usage = { $eq: ['$entryKind', 'usage'] };
    const knownCost = { $and: [notProtection, { $isNumber: '$costUsd' }] };
    const inDay = { $gte: ['$occurredAt', w.dayFrom] };
    const [facets] = await AiUsageReceiptSchema.aggregate<{
        daily: Array<{ _id: string; events: number; credits: number; providerUSD: number }>;
        channels: Array<{ _id: string; events: number; credits: number }>;
        day: Array<{ credits: number; providerUSD: number }>;
        features: Array<{ _id: string; count: number; credits: number; providerUSD: number; known: number }>;
    }>([
        { $match: { occurredAt: { $gte: w.dailyFrom, $lte: w.now } } },
        { $project: { occurredAt: 1, channelID: 1, entryKind: 1, category: 1, operation: 1, credits: 1, costUsd: 1 } },
        {
            $facet: {
                daily: [{
                    $group: {
                        _id: utcDay('$occurredAt'),
                        events: sumIf(notProtection),
                        credits: sumIf(usage, '$credits'),
                        providerUSD: sumIf(knownCost, '$costUsd')
                    }
                }],
                channels: [
                    { $match: { $expr: inDay } },
                    { $group: { _id: '$channelID', events: sumIf(notProtection), credits: sumIf(usage, '$credits') } }
                ],
                day: [
                    { $match: { $expr: inDay } },
                    { $group: { _id: null, credits: sumIf(usage, '$credits'), providerUSD: sumIf(knownCost, '$costUsd') } }
                ],
                features: [
                    { $match: { occurredAt: { $gte: w.weekFrom }, entryKind: 'usage', operation: { $ne: PROTECTION_OPERATION } } },
                    {
                        $group: {
                            _id: '$category', count: { $sum: 1 }, credits: { $sum: '$credits' },
                            providerUSD: sumIf({ $isNumber: '$costUsd' }, '$costUsd'), known: sumIf({ $isNumber: '$costUsd' })
                        }
                    }
                ]
            }
        }
    ] as PipelineStage[]).option({ maxTimeMS: QUERY_MS });
    const features: NonNullable<OverviewFragment['features']> = {};
    for (const row of facets?.features || []) {
        const feature = receiptFeature(row._id);
        const target = features[feature] ||= { count: 0, credits: 0, failed: 0, providerUSD: null };
        target.count = num(target.count) + row.count;
        target.credits = num(target.credits) + row.credits;
        if (row.known > 0) target.providerUSD = num(target.providerUSD) + row.providerUSD;
    }
    return {
        daily: toRecord(facets?.daily || []),
        channels: toRecord(facets?.channels || []),
        day: { credits: num(facets?.day[0]?.credits), providerUSD: num(facets?.day[0]?.providerUSD) },
        features
    };
}

/** A decision the AI was asked for but did not answer (timeout, provider down, no credits). */
const notReviewed = { $and: [{ $eq: ['$mode', 'semantic'] }, { $not: [{ $in: ['$status', REVIEWED_STATUSES] }] }] };
/** Not reviewed, or the action on Twitch failed. */
const decisionProblem = { $or: [notReviewed, { $eq: ['$consequence.success', false] }] };

/**
 * Chat protection decisions. There is no cross-channel `createdAt` index; `expiresAt` is written as
 * createdAt + the retention, so its TTL index bounds the scan to the window.
 */
export async function loadDecisionsFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const expiresFrom = new Date(w.dailyFrom.getTime() + (MODERATION_RETENTION_DAYS - 1) * DAY_MS);
    const inDay = { $gte: ['$createdAt', w.dayFrom] };
    const [facets] = await ModerationDecision.aggregate<{
        daily: Array<{ _id: string; events: number; problems: number; providerUSD: number }>;
        channels: Array<{ _id: string; events: number; problems: number }>;
        day: Array<{ providerUSD: number }>;
        features: Array<{ count: number; failed: number; credits: number; providerUSD: number }>;
    }>([
        { $match: { expiresAt: { $gte: expiresFrom }, createdAt: { $gte: w.dailyFrom, $lte: w.now } } },
        { $project: { createdAt: 1, channelID: 1, mode: 1, status: 1, cost: 1, 'charge.credits': 1, 'consequence.success': 1 } },
        {
            $facet: {
                daily: [{ $group: { _id: utcDay('$createdAt'), events: { $sum: 1 }, problems: sumIf(decisionProblem), providerUSD: { $sum: '$cost' } } }],
                channels: [{ $match: { $expr: inDay } }, { $group: { _id: '$channelID', events: { $sum: 1 }, problems: sumIf(decisionProblem) } }],
                day: [{ $match: { $expr: inDay } }, { $group: { _id: null, providerUSD: { $sum: '$cost' } } }],
                features: [
                    { $match: { createdAt: { $gte: w.weekFrom }, mode: 'semantic' } },
                    { $group: { _id: null, count: { $sum: 1 }, failed: sumIf(notReviewed), credits: { $sum: '$charge.credits' }, providerUSD: { $sum: '$cost' } } }
                ]
            }
        }
    ] as PipelineStage[]).hint({ expiresAt: 1 }).option({ maxTimeMS: QUERY_MS });
    const feature = facets?.features[0];
    return {
        daily: toRecord(facets?.daily || []),
        channels: toRecord(facets?.channels || []),
        day: { providerUSD: num(facets?.day[0]?.providerUSD) },
        features: { protection: { count: num(feature?.count), failed: num(feature?.failed), credits: num(feature?.credits), providerUSD: num(feature?.providerUSD) } }
    };
}

const hashNumber = (hash: Record<string, string> | undefined, field: string): number => {
    const value = Number(hash?.[field]);
    return Number.isFinite(value) ? value : 0;
};

async function dayCounters(keys: string[]): Promise<Record<string, string>[]> {
    const redis = await getDragonflyClient('admin-overview');
    const multi = redis.multi();
    for (const key of keys) multi.hGetAll(key);
    return (await multi.exec()) as unknown as Record<string, string>[];
}

/** Assistant turns from the turn log; before the turn log has rows, the assistant's day counters. */
export async function loadAssistantFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const [facets] = await SiteAgentTurnLog.aggregate<{
        daily: Array<{ _id: string; providerUSD: number }>;
        day: Array<{ providerUSD: number }>;
        features: Array<{ count: number; failed: number; providerUSD: number }>;
    }>([
        { $match: { at: { $gte: w.dailyFrom, $lte: w.now } } },
        { $project: { at: 1, status: 1, costUsd: 1 } },
        {
            $facet: {
                daily: [{ $group: { _id: utcDay('$at'), providerUSD: { $sum: '$costUsd' } } }],
                day: [{ $match: { at: { $gte: w.dayFrom } } }, { $group: { _id: null, providerUSD: { $sum: '$costUsd' } } }],
                features: [
                    { $match: { at: { $gte: w.weekFrom } } },
                    { $group: { _id: null, count: { $sum: 1 }, failed: sumIf({ $in: ['$status', ['failed', 'interrupted']] }), providerUSD: { $sum: '$costUsd' } } }
                ]
            }
        }
    ] as PipelineStage[]).option({ maxTimeMS: QUERY_MS });
    const week = facets?.features[0];
    let feature = { count: num(week?.count), failed: num(week?.failed), providerUSD: num(week?.providerUSD) };
    if (!feature.count) {
        const stats = await dayCounters(w.days.slice(-FEATURE_DAYS).map(SITE_AGENT_KEYS.stats));
        feature = stats.reduce((sum, hash) => ({
            count: sum.count + hashNumber(hash, 'turns'),
            failed: sum.failed + hashNumber(hash, 'turns_failed') + hashNumber(hash, 'turns_interrupted'),
            providerUSD: sum.providerUSD + hashNumber(hash, 'cost_micro_usd') / 1e6
        }), { count: 0, failed: 0, providerUSD: 0 });
    }
    return {
        daily: toRecord(facets?.daily || []),
        day: { providerUSD: num(facets?.day[0]?.providerUSD) },
        features: { assistant: { ...feature, credits: 0 } }
    };
}

const DOCS_RECENT_BATCH = 50;
const DOCS_RECENT_MAX = 1000;

/** What docs answers in the window cost; answers are kept newest first, so the walk stops at the first older one. */
export async function docsCostSince(from: Date): Promise<number> {
    const redis = await getDragonflyClient('admin-overview');
    let total = 0;
    for (let start = 0; start < DOCS_RECENT_MAX; start += DOCS_RECENT_BATCH) {
        const ids = await redis.lRange(DOCS_ASSISTANT_KEYS.recent, start, start + DOCS_RECENT_BATCH - 1);
        if (!ids.length) break;
        const multi = redis.multi();
        for (const id of ids) multi.hmGet(DOCS_ASSISTANT_KEYS.answer(id), ['at', 'cost_usd']);
        const rows = (await multi.exec()) as unknown as Array<[string | null, string | null]>;
        for (const [at, cost] of rows) {
            // An id whose 30-day hash has expired is older than any window read here.
            const time = at ? Date.parse(at) : NaN;
            if (!Number.isFinite(time)) continue;
            if (time < from.getTime()) return total;
            total += Number(cost) || 0;
        }
        if (ids.length < DOCS_RECENT_BATCH) break;
    }
    return total;
}

/** Docs assistant: day counters for the days and features, answer records for the last 24 hours. */
export async function loadDocsFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const [stats, dayCost] = await Promise.all([dayCounters(w.days.map(DOCS_ASSISTANT_KEYS.stats)), docsCostSince(w.dayFrom)]);
    const daily: NonNullable<OverviewFragment['daily']> = {};
    const feature = { count: 0, failed: 0, credits: 0, providerUSD: 0 };
    w.days.forEach((date, index) => {
        const cost = hashNumber(stats[index], 'cost_micro_usd') / 1e6;
        daily[date] = { providerUSD: cost };
        if (index >= w.days.length - FEATURE_DAYS) {
            feature.count += hashNumber(stats[index], 'answered');
            feature.failed += hashNumber(stats[index], 'failed');
            feature.providerUSD += cost;
        }
    });
    return { daily, day: { providerUSD: dayCost }, features: { docs: feature } };
}

/**
 * Things that need the owner. Left out on purpose: `polar_unsent` (the unsent usage lists are one key per
 * channel with no index, so counting them means scanning the keyspace) and `credits_exhausted` (balances
 * are cached per channel for a few minutes, with no list of exhausted channels).
 */
export async function loadAttentionFragment(w: OverviewWindows): Promise<OverviewFragment> {
    const redis = await getDragonflyClient('admin-overview');
    const [reviews, dead, importStuck, gifts] = await Promise.all([
        moderationReviewCountsCached(),
        DomainEventDeliverySchema.countDocuments({ status: 'dead', deadLetteredAt: { $gte: new Date(w.now.getTime() - DEAD_DELIVERY_DAYS * DAY_MS) } }).maxTimeMS(QUERY_MS),
        redis.lLen(AI_USAGE_BACKFILL_DEAD_KEY),
        CreditGiftSchema.countDocuments({ status: 'needs_support' }).maxTimeMS(QUERY_MS)
    ]);
    return {
        attention: {
            verdicts_waiting: Object.values(reviews).reduce((sum, count) => sum + num(count), 0),
            dead_deliveries: dead,
            usage_import_stuck: num(importStuck),
            gifts_need_support: gifts
        }
    };
}

export const overviewLoaders: OverviewLoaders = {
    activity: loadActivityFragment,
    usage: loadUsageFragment,
    decisions: loadDecisionsFragment,
    assistant: loadAssistantFragment,
    docs: loadDocsFragment,
    attention: loadAttentionFragment
};

export const adminOverview = createOverviewService();
