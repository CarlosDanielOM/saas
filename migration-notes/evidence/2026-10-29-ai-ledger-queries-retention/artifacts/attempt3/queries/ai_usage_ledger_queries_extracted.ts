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

export interface AiUsageWindow {
  from: string;
  to: string;
  timeZone: string;
  startTimestamp: Date;
  endTimestampExclusive: Date;
  days: string[];
}

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

export interface IAiUsageLedgerState {
    channelID: string;
    customerId: string;
    coverageStart: Date;
    backfilledAt: Date;
    reportVersion?: number;
    created_at?: Date;
    updated_at?: Date;
}

export interface IAiUsageDaily {
    channelID: string;
    customerId: string;
    date: string;
    dayStart: Date;
    spentCredits: number;
    grantedCredits: number;
    netConsumedCredits: number;
    transactionCount: number;
    categories: Record<string, { credits: number; transactionCount: number }>;
    retentionTier: AiUsageRetentionTier;
    expiresAt: Date;
    created_at?: Date;
    updated_at?: Date;
}

export interface IAiUsageReceipt {
    channelID: string;
    customerId: string;
    entryId: string;
    requestId: string | null;
    occurredAt: Date;
    entryKind: 'usage' | 'adjustment';
    category: string;
    operation: string;
    source?: string | null;
    adjustmentType?: string | null;
    provider: string;
    model: string | null;
    quantity: number | null;
    unit: string | null;
    credits: number;
    resourceType: string | null;
    resourceId: string | null;
    itemized: boolean;
    retentionTier: AiUsageRetentionTier;
    expiresAt: Date;
    created_at?: Date;
    updated_at?: Date;
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

function safeCategory(value: unknown): AiUsageTransaction['category'] {
    return typeof value === 'string' && VALID_CATEGORIES.has(value)
        ? value as AiUsageTransaction['category']
        : 'uncategorized';
}

export function getAiUsageRetentionDays(planTier: unknown): number {
    return RETENTION_DAYS[validTier(planTier)];
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
        itemized: doc.itemized
    }));
}
