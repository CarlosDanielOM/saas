import type { RedisClientType } from 'redis';
import AiUsageDailySchema from '../schemas/ai_usage_daily.schema.js';
import AiUsageLedgerStateSchema from '../schemas/ai_usage_ledger_state.schema.js';
import AiUsageReceiptSchema, { type AiUsageRetentionTier } from '../schemas/ai_usage_receipt.schema.js';
import type { AiUsageContext } from './ai_usage_event.js';
import type { AiUsageTransaction, AiUsageWindow } from './ai_usage_receipts.js';

export const AI_USAGE_RECEIPT_QUEUE_KEY = 'cron:ai-usage-receipts:queue';
export const AI_USAGE_RECEIPT_PROCESSING_KEY = 'cron:ai-usage-receipts:processing';

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

export function getAiUsageRetentionDays(planTier: unknown): number {
    return RETENTION_DAYS[validTier(planTier)];
}

export function buildQueuedAiUsageReceipt(input: {
    channelID: string;
    customerId: string;
    occurredAt?: Date;
    context: AiUsageContext;
    credits: number;
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
        provider: input.context.provider,
        model: input.context.model || null,
        quantity: input.context.quantity ?? null,
        unit: input.context.unit ?? null,
        credits,
        resourceType: input.context.resourceType ?? null,
        resourceId: input.context.resourceId ?? null,
        itemized: true
    };
}

export async function enqueueAiUsageReceipt(
    cache: RedisClientType,
    receipt: QueuedAiUsageReceipt | null
): Promise<void> {
    if (!receipt) return;
    await cache.rPush(AI_USAGE_RECEIPT_QUEUE_KEY, JSON.stringify(receipt));
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
            itemized: parsed.itemized === true
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
        provider: receipt.provider,
        model: receipt.model,
        quantity: receipt.quantity,
        unit: receipt.unit,
        credits: receipt.credits,
        resourceType: receipt.resourceType,
        resourceId: receipt.resourceId,
        itemized: receipt.itemized,
        retentionTier: planTier,
        expiresAt: expiryFor(occurredAt, planTier)
    };
}

async function incrementDaily(receipt: QueuedAiUsageReceipt, planTier: AiUsageRetentionTier): Promise<void> {
    const occurredAt = new Date(receipt.occurredAt);
    const date = occurredAt.toISOString().slice(0, 10);
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const spent = receipt.credits > 0 && receipt.entryKind !== 'adjustment' ? receipt.credits : 0;
    const granted = receipt.credits < 0 ? Math.abs(receipt.credits) : 0;
    const increments: Record<string, number> = {
        spentCredits: spent,
        grantedCredits: granted,
        netConsumedCredits: spent - granted,
        transactionCount: spent > 0 ? 1 : 0
    };
    if (spent > 0) {
        increments[`categories.${safeCategory(receipt.category)}.credits`] = spent;
        increments[`categories.${safeCategory(receipt.category)}.transactionCount`] = 1;
    }
    await AiUsageDailySchema.collection.updateOne(
        { channelID: receipt.channelID, customerId: receipt.customerId, date },
        {
            $setOnInsert: { channelID: receipt.channelID, customerId: receipt.customerId, date, dayStart },
            $set: { retentionTier: planTier },
            $max: { expiresAt: expiryFor(occurredAt, planTier) },
            $inc: increments
        } as any,
        { upsert: true }
    );
}

export async function persistAiUsageReceipt(
    receipt: QueuedAiUsageReceipt,
    planTierInput: unknown
): Promise<'inserted' | 'duplicate' | 'expired'> {
    const planTier = validTier(planTierInput);
    const document = receiptDocument(receipt, planTier);
    if (document.expiresAt.getTime() <= Date.now()) return 'expired';
    const result = await AiUsageReceiptSchema.updateOne(
        { channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id },
        { $setOnInsert: document },
        { upsert: true }
    );
    if (result.upsertedCount !== 1) return 'duplicate';
    await incrementDaily(receipt, planTier);
    return 'inserted';
}

export async function backfillAiUsageLedger(input: {
    channelID: string;
    customerId: string;
    planTier: unknown;
    coverageStart: Date;
    transactions: AiUsageTransaction[];
    now?: Date;
}): Promise<void> {
    const planTier = validTier(input.planTier);
    const now = input.now || new Date();
    const floor = now.getTime() - getAiUsageRetentionDays(planTier) * 86_400_000;
    const receipts = input.transactions
        .map((transaction) => ({ ...transaction, channelID: input.channelID, customerId: input.customerId }))
        .filter((receipt) => new Date(receipt.occurredAt).getTime() >= floor);

    for (let offset = 0; offset < receipts.length; offset += 500) {
        const batch = receipts.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        await AiUsageReceiptSchema.bulkWrite(batch.map((receipt) => ({
            updateOne: {
                filter: { channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id },
                update: { $setOnInsert: receiptDocument(receipt, planTier) },
                upsert: true
            }
        })), { ordered: false });
    }

    await rebuildUtcDailyAggregates(input.channelID, input.customerId, planTier, input.coverageStart, now);
    await AiUsageLedgerStateSchema.findOneAndUpdate(
        { channelID: input.channelID, customerId: input.customerId },
        {
            $min: { coverageStart: input.coverageStart },
            $set: { backfilledAt: now },
            $setOnInsert: { channelID: input.channelID, customerId: input.customerId }
        },
        { upsert: true }
    );
}

async function rebuildUtcDailyAggregates(
    channelID: string,
    customerId: string,
    planTier: AiUsageRetentionTier,
    from: Date,
    to: Date
): Promise<void> {
    const docs = await AiUsageReceiptSchema.find({
        channelID,
        customerId,
        occurredAt: { $gte: from, $lte: to },
        expiresAt: { $gt: new Date() }
    }).lean().exec();
    const rows = new Map<string, {
        spentCredits: number;
        grantedCredits: number;
        transactionCount: number;
        categories: Record<string, { credits: number; transactionCount: number }>;
        expiresAt: Date;
    }>();
    for (const doc of docs) {
        const date = doc.occurredAt.toISOString().slice(0, 10);
        const row = rows.get(date) || {
            spentCredits: 0, grantedCredits: 0, transactionCount: 0, categories: {}, expiresAt: doc.expiresAt
        };
        if (doc.expiresAt > row.expiresAt) row.expiresAt = doc.expiresAt;
        if (doc.credits < 0) row.grantedCredits += Math.abs(doc.credits);
        else if (doc.credits > 0 && doc.entryKind !== 'adjustment') {
            row.spentCredits += doc.credits;
            row.transactionCount += 1;
            const category = safeCategory(doc.category);
            const aggregate = row.categories[category] || { credits: 0, transactionCount: 0 };
            aggregate.credits += doc.credits;
            aggregate.transactionCount += 1;
            row.categories[category] = aggregate;
        }
        rows.set(date, row);
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
            netConsumedCredits: row.spentCredits - row.grantedCredits,
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
        coverageStart: { $lte: input.startsAt }
    }));
}

export async function loadAiUsageLedgerTransactions(input: {
    channelID: string;
    customerId: string;
    window: AiUsageWindow;
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
        provider: doc.provider,
        model: doc.model,
        quantity: doc.quantity,
        unit: doc.unit as AiUsageTransaction['unit'],
        credits: doc.credits,
        resourceType: doc.resourceType as AiUsageTransaction['resourceType'],
        resourceId: doc.resourceId,
        itemized: doc.itemized
    }));
}

export async function adjustAiUsageRetention(channelIDs: string[], planTierInput: unknown): Promise<void> {
    if (channelIDs.length === 0) return;
    const planTier = validTier(planTierInput);
    const days = getAiUsageRetentionDays(planTier);
    const now = new Date();
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
