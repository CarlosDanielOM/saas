"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADJUSTMENT_TYPES = void 0;
exports.classifyAdjustment = classifyAdjustment;
exports.getAiUsageRetentionDays = getAiUsageRetentionDays;
exports.getAiUsageLedgerState = getAiUsageLedgerState;
exports.loadAiUsagePacingHistory = loadAiUsagePacingHistory;
exports.loadAiUsageLedgerTransactions = loadAiUsageLedgerTransactions;
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
function safeCategory(value) {
    return typeof value === 'string' && VALID_CATEGORIES.has(value)
        ? value
        : 'uncategorized';
}
function getAiUsageRetentionDays(planTier) {
    return RETENTION_DAYS[validTier(planTier)];
}
async function getAiUsageLedgerState(input) {
    const state = await AiUsageLedgerStateSchema.findOne({ channelID: input.channelID, customerId: input.customerId })
        .select('coverageStart backfilledAt reportVersion').lean().exec();
    return state ? { coverageStart: state.coverageStart, backfilledAt: state.backfilledAt, reportVersion: state.reportVersion || 0 } : null;
}
async function loadAiUsagePacingHistory(input) {
    const now = input.now || new Date();
    const retentionDays = getAiUsageRetentionDays(input.planTier);
    const retentionStart = new Date(now);
    retentionStart.setUTCHours(0, 0, 0, 0);
    retentionStart.setUTCDate(retentionStart.getUTCDate() - (retentionDays - 1));
    const accountCreatedAt = input.accountCreatedAt instanceof Date
        && !Number.isNaN(input.accountCreatedAt.getTime()) ? input.accountCreatedAt : null;
    const historyStart = accountCreatedAt && accountCreatedAt > retentionStart ? accountCreatedAt : retentionStart;
    const state = await getAiUsageLedgerState({ channelID: input.channelID, customerId: input.customerId });
    if (!state || state.coverageStart.getTime() > historyStart.getTime())
        return null;
    const from = historyStart.toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const totals = await AiUsageDailySchema.aggregate([
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
async function loadAiUsageLedgerTransactions(input) {
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
        unit: doc.unit,
        credits: doc.credits,
        resourceType: doc.resourceType,
        resourceId: doc.resourceId,
        itemized: doc.itemized
    }));
}
