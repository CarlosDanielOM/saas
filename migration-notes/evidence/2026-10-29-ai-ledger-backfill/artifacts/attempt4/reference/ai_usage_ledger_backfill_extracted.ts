export type AiUsageEntryKind = 'usage' | 'adjustment';

export type AiUsageCategory =
    | 'tts'
    | 'ai_chat'
    | 'ai_agent'
    | 'memory'
    | 'clip_recommendation'
    | 'credit_adjustment'
    | 'other';

export type AiUsageUnit = 'characters' | 'tokens' | 'minutes';

export type AiUsageResourceType = 'speech' | 'voice_preview' | 'llm_generation' | 'vod_analysis';

export type AiUsageRetentionTier = 'free' | 'premium' | 'pro';

export type AiUsageReceiptCategory = AiUsageCategory | 'uncategorized';

export interface AiUsageTransaction {
  id: string;
  requestId: string | null;
  occurredAt: string;
  entryKind: AiUsageEntryKind;
  category: AiUsageReceiptCategory;
  operation: string;
  source?: string | null;
  adjustmentType?: string | null;
  provider: string;
  model: string | null;
  quantity: number | null;
  unit: AiUsageUnit | null;
  credits: number;
  resourceType: AiUsageResourceType | null;
  resourceId: string | null;
  itemized: boolean;
}

export interface QueuedAiUsageReceipt extends AiUsageTransaction {
    channelID: string;
    customerId: string;
}

export const ADJUSTMENT_TYPES = ['manual_grant', 'monthly_reset', 'subscription_credits', 'purchased_pack', 'gifted_credits', 'native_grant', 'refund', 'correction', 'activation', 'other'] as const;

export function classifyAdjustment(input: { entryKind?: unknown; operation?: unknown; source?: unknown; reason?: unknown; adjustmentType?: unknown }): string | null {
    if (input.entryKind !== 'adjustment') return null;
    if (ADJUSTMENT_TYPES.includes(input.adjustmentType as any)) return String(input.adjustmentType);
    const source = String(input.source || '');
    const operation = String(input.operation || '');
    if (source === 'polar_meter_credit') return 'native_grant';
    if (['free_credit_reset', 'free_credit_reset_worker'].includes(source) || operation === 'monthly_reset') return 'monthly_reset';
    if (source === 'admin_credit_grant') return 'manual_grant';
    if (source === 'credit_pack_purchase' || operation === 'purchase_pack') return 'purchased_pack';
    if (operation === 'refund') return 'refund';
    if (operation === 'correction') return 'correction';
    if (source === 'activation' || input.reason === 'Free benefits') return 'activation';
    return 'other';
}

const RETENTION_DAYS: Record<AiUsageRetentionTier, number> = {
    free: 30,
    premium: 60,
    pro: 90
};

const VALID_CATEGORIES = new Set([
    'tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation',
    'credit_adjustment', 'other', 'uncategorized'
]);

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

export function getAiUsageRetentionDays(planTier: unknown): number {
    return RETENTION_DAYS[validTier(planTier)];
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
        itemized: receipt.itemized,
        retentionTier: planTier,
        expiresAt: expiryFor(occurredAt, planTier)
    };
}

export const AI_USAGE_REPORT_VERSION = 3;

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
        await AiUsageReceiptSchema.bulkWrite(batch.map((receipt) => ({
            updateOne: {
                filter: { channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id },
                update: { $setOnInsert: (() => {
                    const { source, adjustmentType, ...document } = receiptDocument(receipt, planTier);
                    return document;
                })(), $set: { source: receipt.source || null, adjustmentType: receipt.adjustmentType || classifyAdjustment(receipt) } },
                upsert: true
            }
        })), { ordered: false });
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
