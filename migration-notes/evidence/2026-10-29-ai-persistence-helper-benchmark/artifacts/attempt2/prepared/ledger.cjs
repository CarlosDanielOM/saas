"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADJUSTMENT_TYPES = void 0;
exports.classifyAdjustment = classifyAdjustment;
exports.getAiUsageRetentionDays = getAiUsageRetentionDays;
exports.persistAiUsageReceipt = persistAiUsageReceipt;
exports.receiptDocument = receiptDocument;
exports.ADJUSTMENT_TYPES = ['manual_grant', 'monthly_reset', 'subscription_credits', 'purchased_pack', 'gifted_credits', 'native_grant', 'refund', 'correction', 'activation', 'other'];
function classifyAdjustment(input) {
    if (input.entryKind !== 'adjustment')
        return null;
    if (exports.ADJUSTMENT_TYPES.includes(input.adjustmentType))
        return String(input.adjustmentType);
    const source = String(input.source || '');
    const operation = String(input.operation || '');
    if (source === 'polar_meter_credit')
        return 'native_grant';
    if (['free_credit_reset', 'free_credit_reset_worker'].includes(source) || operation === 'monthly_reset')
        return 'monthly_reset';
    if (source === 'admin_credit_grant')
        return 'manual_grant';
    if (source === 'credit_pack_purchase' || operation === 'purchase_pack')
        return 'purchased_pack';
    if (operation === 'refund')
        return 'refund';
    if (operation === 'correction')
        return 'correction';
    if (source === 'activation' || input.reason === 'Free benefits')
        return 'activation';
    return 'other';
}
const RETENTION_DAYS = {
    free: 30,
    premium: 60,
    pro: 90
};
const VALID_CATEGORIES = new Set([
    'tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation',
    'credit_adjustment', 'other', 'uncategorized'
]);
function validTier(value) {
    return value === 'premium' || value === 'pro' ? value : 'free';
}
function expiryFor(occurredAt, planTier) {
    return new Date(occurredAt.getTime() + getAiUsageRetentionDays(planTier) * 86_400_000);
}
function safeCategory(value) {
    return typeof value === 'string' && VALID_CATEGORIES.has(value)
        ? value
        : 'uncategorized';
}
function getAiUsageRetentionDays(planTier) {
    return RETENTION_DAYS[validTier(planTier)];
}
function receiptDocument(receipt, planTier) {
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
async function persistAiUsageReceipt(receipt, planTierInput) {
    return withAiUsageLock(receipt.channelID, receipt.customerId, async () => {
        const planTier = validTier(planTierInput);
        await Dashboards.updateMany({ channelID: receipt.channelID, customerId: receipt.customerId }, { $set: { dirty: true } });
        const document = receiptDocument(receipt, planTier);
        if (document.expiresAt.getTime() <= Date.now())
            return 'expired';
        const result = await AiUsageReceiptSchema.updateOne({ channelID: receipt.channelID, customerId: receipt.customerId, entryId: receipt.id }, { $setOnInsert: document }, { upsert: true });
        // Rebuild on duplicate as well: a prior crash may have saved only the receipt.
        const dayStart = new Date(receipt.occurredAt.slice(0, 10) + 'T00:00:00.000Z');
        await rebuildUtcDailyAggregates(receipt.channelID, receipt.customerId, planTier, dayStart, new Date(dayStart.getTime() + 86_400_000 - 1));
        return result.upsertedCount === 1 ? 'inserted' : 'duplicate';
    });
}
async function rebuildUtcDailyAggregates(channelID, customerId, planTier, from, to) {
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
    const rows = new Map();
    for (const group of groups) {
        const row = rows.get(group._id.date) || { spentCredits: 0, grantedCredits: 0, debitedCredits: 0, transactionCount: 0, categories: {}, expiresAt: group.expiresAt };
        row.spentCredits += group.spent;
        row.grantedCredits += group.granted;
        row.debitedCredits += group.debited;
        row.transactionCount += group.count;
        if (group.expiresAt > row.expiresAt)
            row.expiresAt = group.expiresAt;
        if (group.count)
            row.categories[safeCategory(group._id.category)] = { credits: group.spent, transactionCount: group.count };
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
