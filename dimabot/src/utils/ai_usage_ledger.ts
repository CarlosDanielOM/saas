import Dashboards from '../schemas/ai_usage_dashboard.schema.js';
import { withAiUsageLock } from './ai_usage_lock.js';
import { classifyAdjustment } from './ai_usage_classification.js';
import type { RedisClientType } from 'redis';
import AiUsageDailySchema from '../schemas/ai_usage_daily.schema.js';
import AiUsageLedgerStateSchema from '../schemas/ai_usage_ledger_state.schema.js';
import AiUsageReceiptSchema, { type AiUsageRetentionTier } from '../schemas/ai_usage_receipt.schema.js';
import type { AiUsageActor, AiUsageContext } from './ai_usage_event.js';
import type { AiUsageTransaction, AiUsageWindow } from './ai_usage_receipts.js';

export const AI_USAGE_RECEIPT_QUEUE_KEY = 'cron:ai-usage-receipts:queue';
export const AI_USAGE_RECEIPT_PROCESSING_KEY = 'cron:ai-usage-receipts:processing';
export const AI_USAGE_REPORT_VERSION = 3;

const RETENTION_DAYS: Record<AiUsageRetentionTier, number> = {
    free: 30,
    premium: 60,
    pro: 90
};
const VALID_CATEGORIES = new Set([
    'tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation',
    'credit_adjustment', 'other', 'uncategorized'
]);

export interface QueuedAiUsageReceipt extends AiUsageTransaction {
    channelID: string;
    customerId: string;
    /**
     * Set when the bot classified the usage more precisely than Polar was told (a reward is 'redemption'
     * here, 'ast' in Polar). It is the authoritative source: it replaces what an earlier backfill stored.
     */
    receiptSource?: string | null;
}

export interface AiUsageLedgerStatus {
    status: 'ready' | 'pending';
    coverageStart: string | null;
    lastSyncedAt: string | null;
    requestedCoverageStart: string;
}

export interface AiUsagePacingHistory {
    activeDayCount?: number;
    coefficientOfVariation?: number;
    recentAverageDailyCredits?: number;
    recentDayCount?: number;
    averageDailyCredits: number;
    totalSpentCredits: number;
    dayCount: number;
    from: string;
    to: string;
}

function validTier(value: unknown): AiUsageRetentionTier {
    return value === 'premium' || value === 'pro' ? value : 'free';
}

function expiryFor(occurredAt: Date, planTier: AiUsageRetentionTier): Date {
    return new Date(occurredAt.getTime() + getAiUsageRetentionDays(planTier) * 86_400_000);
}

function safeCategory(value: unknown): AiUsageTransaction['category'] {
    return typeof value === 'string' && VALID_CATEGORIES.has(value)
        ? value as AiUsageTransaction['category']
        : 'uncategorized';
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

function finiteNumber(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

const TWITCH_ID = /^\d{1,20}$/;
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Receipt fields for an actor; anything that does not look like a Twitch id or login is dropped. */
function receiptActor(actor: AiUsageActor | null | undefined): Pick<AiUsageTransaction, 'actorId' | 'actorLogin' | 'actorName'> {
    const id = typeof actor?.id === 'string' ? actor.id.trim() : '';
    const login = typeof actor?.login === 'string' ? actor.login.trim().toLowerCase() : '';
    const name = typeof actor?.name === 'string' ? Array.from(actor.name.replace(CONTROL_CHARACTERS, '').trim()).slice(0, 64).join('') : '';
    return {
        actorId: TWITCH_ID.test(id) ? id : null,
        actorLogin: TWITCH_LOGIN.test(login) ? login : null,
        actorName: name || null
    };
}

function costUsd(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The receipt fields that are new since the owner console. Queue entries keep them only when set, so
 * system work queues exactly what it did before, and an older reader ignores them.
 */
function receiptExtras(receipt: Pick<QueuedAiUsageReceipt, 'actorId' | 'actorLogin' | 'actorName' | 'voice' | 'costUsd' | 'receiptSource'>) {
    return Object.fromEntries(Object.entries({
        actorId: receipt.actorId ?? null, actorLogin: receipt.actorLogin ?? null, actorName: receipt.actorName ?? null,
        voice: receipt.voice ?? null, costUsd: receipt.costUsd ?? null, receiptSource: receipt.receiptSource ?? null
    }).filter(([, value]) => value !== null)) as Partial<QueuedAiUsageReceipt>;
}

export function getAiUsageRetentionDays(planTier: unknown): number {
    return RETENTION_DAYS[validTier(planTier)];
}

export function buildQueuedAiUsageReceipt(input: {
    channelID: string;
    customerId: string;
    occurredAt?: Date;
    context: AiUsageContext;
    credits: number;
    /** USD the provider charged, already normalized (see `receiptCostUsd` in polarsh.ts). */
    costUsd?: number | null;
}): QueuedAiUsageReceipt | null {
    const occurredAt = input.occurredAt || new Date();
    if (!input.channelID || !input.customerId || Number.isNaN(occurredAt.getTime())) return null;
    const credits = finiteNumber(input.credits);
    if (credits === null) return null;

    return {
        channelID: input.channelID,
        customerId: input.customerId,
        id: input.context.entryId,
        requestId: input.context.requestId || null,
        occurredAt: occurredAt.toISOString(),
        entryKind: input.context.entryKind,
        category: safeCategory(input.context.category),
        operation: input.context.operation,
        // Polar history has only the shared source, so a receipt imported from Polar keeps saying 'ast' for a reward.
        source: nullableString(input.context.receipt?.source) || input.context.source,
        adjustmentType: classifyAdjustment(input.context),
        provider: input.context.provider,
        model: input.context.model || nullableString(input.context.receipt?.model),
        quantity: input.context.quantity ?? null,
        unit: input.context.unit ?? null,
        credits,
        resourceType: input.context.resourceType ?? null,
        resourceId: input.context.resourceId ?? null,
        itemized: true,
        ...receiptExtras({
            ...receiptActor(input.context.receipt?.actor),
            voice: nullableString(input.context.receipt?.voice),
            costUsd: costUsd(input.costUsd),
            receiptSource: nullableString(input.context.receipt?.source)
        })
    };
}

export async function enqueueAiUsageReceipt(
    cache: RedisClientType,
    receipt: QueuedAiUsageReceipt | null
): Promise<void> {
    if (!receipt) return;
    await cache.rPush(AI_USAGE_RECEIPT_QUEUE_KEY, JSON.stringify({ ...receipt, enqueuedAt: new Date().toISOString() }));
}

export function parseQueuedAiUsageReceipt(raw: string): QueuedAiUsageReceipt | null {
    try {
        const parsed = JSON.parse(raw) as Partial<QueuedAiUsageReceipt>;
        const occurredAt = new Date(String(parsed.occurredAt || ''));
        const credits = finiteNumber(parsed.credits);
        if (!parsed.channelID || !parsed.customerId || !parsed.id || Number.isNaN(occurredAt.getTime()) || credits === null) {
            return null;
        }
        return {
            channelID: String(parsed.channelID),
            customerId: String(parsed.customerId),
            id: String(parsed.id),
            requestId: nullableString(parsed.requestId),
            occurredAt: occurredAt.toISOString(),
            entryKind: parsed.entryKind === 'adjustment' || credits < 0 ? 'adjustment' : 'usage',
            category: safeCategory(parsed.category),
            operation: nullableString(parsed.operation) || 'usage',
            source: nullableString(parsed.source),
            adjustmentType: classifyAdjustment({ ...parsed, entryKind: parsed.entryKind === 'adjustment' || credits < 0 ? 'adjustment' : 'usage' }),
            provider: nullableString(parsed.provider) || 'unknown',
            model: nullableString(parsed.model),
            quantity: finiteNumber(parsed.quantity),
            unit: parsed.unit === 'characters' || parsed.unit === 'tokens' || parsed.unit === 'minutes' ? parsed.unit : null,
            credits,
            resourceType: parsed.resourceType === 'speech'
                || parsed.resourceType === 'voice_preview'
                || parsed.resourceType === 'llm_generation'
                || parsed.resourceType === 'vod_analysis' ? parsed.resourceType : null,
            resourceId: nullableString(parsed.resourceId),
            itemized: parsed.itemized === true,
            // Entries queued by an older version have none of these: they become nulls.
            ...receiptActor({ id: parsed.actorId, login: parsed.actorLogin, name: parsed.actorName }),
            voice: nullableString(parsed.voice),
            costUsd: costUsd(parsed.costUsd),
            receiptSource: nullableString(parsed.receiptSource)
        };
    } catch {
        return null;
    }
}

function receiptDocument(receipt: QueuedAiUsageReceipt, planTier: AiUsageRetentionTier) {
    const occurredAt = new Date(receipt.occurredAt);
    return {
        channelID: receipt.channelID,
        customerId: receipt.customerId,
        entryId: receipt.id,
        requestId: receipt.requestId,
        occurredAt,
        entryKind: receipt.entryKind,
        category: safeCategory(receipt.category),
        operation: receipt.operation,
        source: receipt.source || null,
        adjustmentType: receipt.adjustmentType || classifyAdjustment(receipt),
        provider: receipt.provider,
        model: receipt.model,
        quantity: receipt.quantity,
        unit: receipt.unit,
        credits: receipt.credits,
        resourceType: receipt.resourceType,
        resourceId: receipt.resourceId,
        actorId: receipt.actorId ?? null,
        actorLogin: receipt.actorLogin ?? null,
        actorName: receipt.actorName ?? null,
        costUsd: receipt.costUsd ?? null,
        voice: receipt.voice ?? null,
        itemized: receipt.itemized,
        retentionTier: planTier,
        expiresAt: expiryFor(occurredAt, planTier)
    };
}

const ENRICHMENT_FIELDS = ['actorId', 'actorLogin', 'actorName', 'voice', 'model', 'costUsd'] as const;

/**
 * The Polar backfill can store a receipt before the receipts worker reaches the live entry for it, and
 * Polar history carries no chatter, voice or provider cost. Fill in only what the stored receipt still
 * lacks, and take the bot's own source when it has one (a reward that Polar knows as 'ast'): it is the
 * authoritative classification. Credits, category, time and retention stay as stored, so the daily
 * rollup (by category) does not change.
 */
async function fillReceiptEnrichment(
    filter: { channelID: string; customerId: string; entryId: string },
    document: ReturnType<typeof receiptDocument>,
    receiptSource: string | null | undefined
): Promise<void> {
    // $literal: every value is data, never an expression or a field path.
    const fill: Record<string, unknown> = receiptSource ? { source: { $literal: receiptSource } } : {};
    for (const field of ENRICHMENT_FIELDS) {
        const value = document[field];
        if (value !== null && value !== undefined) fill[field] = { $ifNull: ['$' + field, { $literal: value }] };
    }
    if (Object.keys(fill).length > 0) await AiUsageReceiptSchema.updateOne(filter, [{ $set: fill }]);
}

export async function persistAiUsageReceipt(
    receipt: QueuedAiUsageReceipt,
    planTierInput: unknown
): Promise<'inserted' | 'duplicate' | 'expired'> {
    return withAiUsageLock(receipt.channelID, receipt.customerId, async () => {
    const planTier = validTier(planTierInput);
    await Dashboards.updateMany({ channelID: receipt.channelID, customerId: receipt.customerId }, { $set: { dirty: true } });
    const document = receiptDocument(receipt, planTier);
    if (document.expiresAt.getTime() <= Date.now()) return 'expired';
    const filter = { channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id };
    const result = await AiUsageReceiptSchema.updateOne(filter, { $setOnInsert: document }, { upsert: true });
    if (result.upsertedCount !== 1) await fillReceiptEnrichment(filter, document, receipt.receiptSource);
    // Rebuild on duplicate as well: a prior crash may have saved only the receipt.
    const dayStart = new Date(receipt.occurredAt.slice(0, 10) + 'T00:00:00.000Z');
    await rebuildUtcDailyAggregates(receipt.channelID, receipt.customerId, planTier, dayStart, new Date(dayStart.getTime() + 86_400_000 - 1));
    return result.upsertedCount === 1 ? 'inserted' : 'duplicate';
    });
}

export async function backfillAiUsageLedger(input: {
    channelID: string;
    customerId: string;
    planTier: unknown;
    coverageStart: Date;
    rebuildStart?: Date;
    transactions: AiUsageTransaction[];
    now?: Date;
}): Promise<void> {
    return withAiUsageLock(input.channelID, input.customerId, async () => {
    await Dashboards.updateMany({ channelID: input.channelID, customerId: input.customerId }, { $set: { dirty: true } });
    const planTier = validTier(input.planTier);
    const now = input.now || new Date();
    const floor = now.getTime() - getAiUsageRetentionDays(planTier) * 86_400_000;
    const receipts = input.transactions
        .map((transaction) => ({ ...transaction, channelID: input.channelID, customerId: input.customerId }))
        .filter((receipt) => new Date(receipt.occurredAt).getTime() >= floor);

    for (let offset = 0; offset < receipts.length; offset += 500) {
        const batch = receipts.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        await AiUsageReceiptSchema.bulkWrite(batch.flatMap((receipt) => {
            const filter = { channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id };
            const { adjustmentType, ...document } = receiptDocument(receipt, planTier);
            return [
                // What a live receipt recorded (chatter, voice, provider cost) is never overwritten.
                { updateOne: { filter, update: { $setOnInsert: document, $set: { adjustmentType } }, upsert: true } },
                // Receipts stored before sources were recorded get Polar's. A live receipt's own source wins:
                // a channel-point reward is 'redemption' there and 'ast' in Polar. The two writes touch
                // different documents or different fields, so their order in the batch does not matter.
                ...(document.source ? [{ updateOne: { filter: { ...filter, source: null }, update: { $set: { source: document.source } } } }] : [])
            ];
        }), { ordered: false });
    }

    await rebuildUtcDailyAggregates(
        input.channelID,
        input.customerId,
        planTier,
        input.rebuildStart || input.coverageStart,
        now
    );
    await AiUsageLedgerStateSchema.findOneAndUpdate(
        { channelID: input.channelID, customerId: input.customerId },
        {
            $min: { coverageStart: input.coverageStart },
            $set: { backfilledAt: now, reportVersion: AI_USAGE_REPORT_VERSION },
            $setOnInsert: { channelID: input.channelID, customerId: input.customerId }
        },
        { upsert: true }
    );
    });
}

async function rebuildUtcDailyAggregates(
    channelID: string,
    customerId: string,
    planTier: AiUsageRetentionTier,
    from: Date,
    to: Date
): Promise<void> {
    from = new Date(from.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    to = new Date(new Date(to.toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + 86_400_000 - 1);
    const usage = { $and: [{ $gt: ['$credits', 0] }, { $ne: ['$entryKind', 'adjustment'] }] };
    const groups = await AiUsageReceiptSchema.aggregate([
        { $match: { channelID, customerId, occurredAt: { $gte: from, $lte: to }, expiresAt: { $gt: new Date() } } },
        { $group: { _id: { date: { $dateToString: { date: '$occurredAt', format: '%Y-%m-%d', timezone: 'UTC' } }, category: '$category' },
            spent: { $sum: { $cond: [usage, '$credits', 0] } },
            granted: { $sum: { $cond: [{ $lt: ['$credits', 0] }, { $multiply: ['$credits', -1] }, 0] } },
            debited: { $sum: { $cond: [{ $and: [{ $gt: ['$credits', 0] }, { $eq: ['$entryKind', 'adjustment'] }] }, '$credits', 0] } },
            count: { $sum: { $cond: [usage, 1, 0] } }, expiresAt: { $max: '$expiresAt' }
        } }
    ]).exec();
    const rows = new Map<string, { spentCredits: number; grantedCredits: number; debitedCredits: number;
        transactionCount: number; categories: Record<string, { credits: number; transactionCount: number }>; expiresAt: Date }>();
    for (const group of groups) {
        const row = rows.get(group._id.date) || { spentCredits: 0, grantedCredits: 0, debitedCredits: 0, transactionCount: 0, categories: {} as Record<string, { credits: number; transactionCount: number }>, expiresAt: group.expiresAt };
        row.spentCredits += group.spent; row.grantedCredits += group.granted; row.debitedCredits += group.debited;
        row.transactionCount += group.count;
        if (group.expiresAt > row.expiresAt) row.expiresAt = group.expiresAt;
        if (group.count) row.categories[safeCategory(group._id.category)] = { credits: group.spent, transactionCount: group.count };
        rows.set(group._id.date, row);
    }
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    await AiUsageDailySchema.deleteMany({ channelID, customerId, date: { $gte: fromDate, $lte: toDate } });
    if (rows.size > 0) {
        await AiUsageDailySchema.insertMany([...rows.entries()].map(([date, row]) => ({
            channelID,
            customerId,
            date,
            dayStart: new Date(`${date}T00:00:00.000Z`),
            spentCredits: row.spentCredits,
            grantedCredits: row.grantedCredits,
            netConsumedCredits: row.spentCredits + row.debitedCredits - row.grantedCredits,
            transactionCount: row.transactionCount,
            categories: row.categories,
            retentionTier: planTier,
            expiresAt: row.expiresAt
        })), { ordered: false });
    }
}

export async function hasAiUsageLedgerCoverage(input: {
    channelID: string;
    customerId: string;
    startsAt: Date;
}): Promise<boolean> {
    return Boolean(await AiUsageLedgerStateSchema.exists({
        channelID: input.channelID,
        customerId: input.customerId,
        coverageStart: { $lte: input.startsAt },
        reportVersion: { $gte: AI_USAGE_REPORT_VERSION }
    }));
}

export async function getAiUsageLedgerStatus(input: {
    channelID: string;
    customerId: string;
    startsAt: Date;
}): Promise<AiUsageLedgerStatus> {
    const state = await AiUsageLedgerStateSchema.findOne({
        channelID: input.channelID,
        customerId: input.customerId
    }).select('coverageStart backfilledAt reportVersion').lean().exec();
    const ready = Boolean(state && state.coverageStart.getTime() <= input.startsAt.getTime()
        && (state.reportVersion || 0) >= AI_USAGE_REPORT_VERSION);
    return {
        status: ready ? 'ready' : 'pending',
        coverageStart: state?.coverageStart?.toISOString() || null,
        lastSyncedAt: state?.backfilledAt?.toISOString() || null,
        requestedCoverageStart: input.startsAt.toISOString()
    };
}

export async function getAiUsageLedgerState(input: {
    channelID: string;
    customerId: string;
}): Promise<{ coverageStart: Date; backfilledAt: Date; reportVersion: number } | null> {
    const state = await AiUsageLedgerStateSchema.findOne({ channelID: input.channelID, customerId: input.customerId })
        .select('coverageStart backfilledAt reportVersion').lean().exec();
    return state ? { coverageStart: state.coverageStart, backfilledAt: state.backfilledAt, reportVersion: state.reportVersion || 0 } : null;
}

export async function loadAiUsagePacingHistory(input: {
    channelID: string;
    customerId: string;
    planTier: unknown;
    accountCreatedAt?: Date | null;
    now?: Date;
}): Promise<AiUsagePacingHistory | null> {
    const now = input.now || new Date();
    const retentionDays = getAiUsageRetentionDays(input.planTier);
    const retentionStart = new Date(now);
    retentionStart.setUTCHours(0, 0, 0, 0);
    retentionStart.setUTCDate(retentionStart.getUTCDate() - (retentionDays - 1));
    const accountCreatedAt = input.accountCreatedAt instanceof Date
        && !Number.isNaN(input.accountCreatedAt.getTime()) ? input.accountCreatedAt : null;
    const historyStart = accountCreatedAt && accountCreatedAt > retentionStart ? accountCreatedAt : retentionStart;
    const state = await getAiUsageLedgerState({ channelID: input.channelID, customerId: input.customerId });
    if (!state || state.coverageStart.getTime() > historyStart.getTime()) return null;

    const from = historyStart.toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const totals = await AiUsageDailySchema.aggregate<{ totalSpentCredits: number }>([
        {
            $match: {
                channelID: input.channelID,
                customerId: input.customerId,
                date: { $gte: from, $lte: to },
                expiresAt: { $gt: now }
            }
        },
        { $group: { _id: null, totalSpentCredits: { $sum: '$spentCredits' } } }
    ]).exec();
    const totalSpentCredits = Math.max(0, Number(totals[0]?.totalSpentCredits || 0));
    const elapsedDays = Math.max(1, (now.getTime() - historyStart.getTime()) / 86_400_000);
    const dayCount = Math.min(retentionDays, elapsedDays);
    return {
        averageDailyCredits: totalSpentCredits / dayCount,
        totalSpentCredits,
        dayCount,
        from,
        to
    };
}

export async function loadAiUsageLedgerTransactions(input: {
    channelID: string;
    customerId: string;
    window: AiUsageWindow;
    /** Owner-only reads; streamer-facing responses must leave it off. */
    includeCostUsd?: boolean;
}): Promise<AiUsageTransaction[]> {
    const docs = await AiUsageReceiptSchema.find({
        channelID: input.channelID,
        customerId: input.customerId,
        occurredAt: { $gte: input.window.startTimestamp, $lt: input.window.endTimestampExclusive },
        expiresAt: { $gt: new Date() }
    }).sort({ occurredAt: -1, entryId: -1 }).lean().exec();
    return docs.map((doc) => ({
        id: doc.entryId,
        requestId: doc.requestId,
        occurredAt: doc.occurredAt.toISOString(),
        entryKind: doc.entryKind,
        category: safeCategory(doc.category),
        operation: doc.operation,
        source: doc.source || null,
        adjustmentType: doc.adjustmentType || classifyAdjustment(doc),
        provider: doc.provider,
        model: doc.model,
        quantity: doc.quantity,
        unit: doc.unit as AiUsageTransaction['unit'],
        credits: doc.credits,
        resourceType: doc.resourceType as AiUsageTransaction['resourceType'],
        resourceId: doc.resourceId,
        itemized: doc.itemized,
        actorId: doc.actorId ?? null,
        actorLogin: doc.actorLogin ?? null,
        actorName: doc.actorName ?? null,
        voice: doc.voice ?? null,
        ...(input.includeCostUsd ? { costUsd: doc.costUsd ?? null } : {})
    }));
}

export async function adjustAiUsageRetention(channelIDs: string[], planTierInput: unknown): Promise<void> {
    if (channelIDs.length === 0) return;
    const planTier = validTier(planTierInput);
    const days = getAiUsageRetentionDays(planTier);
    const now = new Date();
    await Dashboards.deleteMany({ channelID: { $in: channelIDs } });
    await AiUsageLedgerStateSchema.updateMany({ channelID: { $in: channelIDs } }, { $max: { coverageStart: new Date(now.getTime() - days * 86_400_000) } });
    await AiUsageReceiptSchema.updateMany({ channelID: { $in: channelIDs } }, [{
        $set: {
            retentionTier: planTier,
            expiresAt: { $dateAdd: { startDate: '$occurredAt', unit: 'day', amount: days } }
        }
    }]);
    await AiUsageDailySchema.updateMany({ channelID: { $in: channelIDs } }, [{
        $set: {
            retentionTier: planTier,
            expiresAt: { $dateAdd: { startDate: '$dayStart', unit: 'day', amount: days + 1 } }
        }
    }]);
    await Promise.all([
        AiUsageReceiptSchema.deleteMany({ channelID: { $in: channelIDs }, expiresAt: { $lte: now } }),
        AiUsageDailySchema.deleteMany({ channelID: { $in: channelIDs }, expiresAt: { $lte: now } })
    ]);
}
