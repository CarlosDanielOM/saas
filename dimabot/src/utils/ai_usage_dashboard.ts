import { createHash } from 'node:crypto';
import Dashboards from '../schemas/ai_usage_dashboard.schema.js';
import Receipts from '../schemas/ai_usage_receipt.schema.js';
import { getAiUsageRetentionDays, getAiUsageLedgerState, type AiUsagePacingHistory } from './ai_usage_ledger.js';
import { AI_USAGE_ITEMIZATION_STARTED_AT, type AiUsageWindow } from './ai_usage_receipts.js';
import { withAiUsageLock } from './ai_usage_lock.js';
import type { PipelineStage } from 'mongoose';

const DAY = 86_400_000;
export interface DashboardRequest {
    channelID: string; customerId: string; planTier: string; accountCreatedAt: string;
    window: { from: string; to: string; timeZone: string; startTimestamp: string; endTimestampExclusive: string; days: string[] };
}
// At most one aggregate row per day/category/kind/type, regardless of receipt volume.
async function aggregateRows(request: DashboardRequest, start: Date, end: Date, timeZone: string, now: Date) {
    return Receipts.aggregate([
        { $match: { channelID: request.channelID, customerId: request.customerId,
            occurredAt: { $gte: start, $lt: end }, expiresAt: { $gt: now } } },
        { $group: { _id: { date: { $dateToString: { date: '$occurredAt', format: '%Y-%m-%d', timezone: timeZone } },
            category: '$category', kind: '$entryKind', adjustmentType: { $ifNull: ['$adjustmentType', 'other'] } },
            spent: { $sum: { $cond: [{ $and: [{ $gt: ['$credits', 0] }, { $ne: ['$entryKind', 'adjustment'] }] }, '$credits', 0] } },
            granted: { $sum: { $cond: [{ $lt: ['$credits', 0] }, { $multiply: ['$credits', -1] }, 0] } },
            debited: { $sum: { $cond: [{ $and: [{ $gt: ['$credits', 0] }, { $eq: ['$entryKind', 'adjustment'] }] }, '$credits', 0] } },
            count: { $sum: { $cond: [{ $and: [{ $gt: ['$credits', 0] }, { $ne: ['$entryKind', 'adjustment'] }] }, 1, 0] } },
            adjustments: { $sum: { $cond: [{ $or: [{ $eq: ['$entryKind', 'adjustment'] }, { $lt: ['$credits', 0] }] }, 1, 0] } }
        } }
    ] as PipelineStage[]).exec();
}
export async function computeDashboard(request: DashboardRequest, now = new Date()) {
    const window = request.window;
    const rows = await aggregateRows(request, new Date(window.startTimestamp), new Date(window.endTimestampExclusive), window.timeZone, now);
    const daily = new Map(window.days.map(date => [date, { date, credits: 0, transactionCount: 0 }]));
    const categories = new Map<string, { category: string; credits: number; transactionCount: number }>();
    const adjustments = new Map<string, { type: string; grantedCredits: number; debitedCredits: number; transactionCount: number }>();
    let spent = 0, granted = 0, debited = 0, count = 0;
    for (const row of rows) {
        spent += row.spent; granted += row.granted; debited += row.debited; count += row.count;
        const day = daily.get(row._id.date);
        if (day) { day.credits += row.spent; day.transactionCount += row.count; }
        if (row.count) {
            const key = row._id.category || 'uncategorized';
            const category = categories.get(key) || { category: key, credits: 0, transactionCount: 0 };
            category.credits += row.spent; category.transactionCount += row.count; categories.set(key, category);
        }
        if (row.adjustments) {
            const key = row._id.adjustmentType;
            const adjustment = adjustments.get(key) || { type: key, grantedCredits: 0, debitedCredits: 0, transactionCount: 0 };
            adjustment.grantedCredits += row.granted; adjustment.debitedCredits += row.debited;
            adjustment.transactionCount += row.adjustments; adjustments.set(key, adjustment);
        }
    }
    const summary = {
        schemaVersion: 1, itemizationStartedAt: AI_USAGE_ITEMIZATION_STARTED_AT,
        period: { from: window.from, to: window.to, timeZone: window.timeZone, dayCount: window.days.length },
        totalSpentCredits: spent, averageDailySpentCredits: Math.round(spent / Math.max(1, window.days.length) * 100) / 100,
        grantedCredits: granted, adjustmentDebitedCredits: debited,
        netConsumedCredits: spent + debited - granted, transactionCount: count,
        daily: [...daily.values()],
        categories: [...categories.values()].sort((a, b) => b.credits - a.credits || a.category.localeCompare(b.category))
            .map(row => ({ ...row, percentage: spent ? Math.round(row.credits / spent * 10000) / 100 : 0 })),
        adjustments: [...adjustments.values()].sort((a, b) => a.type.localeCompare(b.type))
    };
    const state = await getAiUsageLedgerState(request);
    // Only completed UTC days enter the baseline; today's partial activity cannot inflate its rate.
    const end = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const floor = Math.max(now.getTime() - getAiUsageRetentionDays(request.planTier) * DAY,
        new Date(request.accountCreatedAt).getTime() || 0, state?.coverageStart.getTime() || now.getTime());
    const start = new Date(Math.ceil(floor / DAY) * DAY);
    const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY));
    let history: AiUsagePacingHistory | null = null;
    if (days > 0 && state) {
        const historyRows = await aggregateRows(request, start, end, 'UTC', now);
        const totals = new Map<string, number>();
        for (const row of historyRows) totals.set(row._id.date, (totals.get(row._id.date) || 0) + row.spent);
        const samples = Array.from({ length: days }, (_, i) => totals.get(new Date(start.getTime() + i * DAY).toISOString().slice(0, 10)) || 0);
        const total = samples.reduce((a, b) => a + b, 0);
        const mean = total / days;
        const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / days;
        const recent = samples.slice(-7);
        history = { averageDailyCredits: mean, totalSpentCredits: total, dayCount: days,
            from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - 1).toISOString().slice(0, 10),
            activeDayCount: samples.filter(value => value > 0).length,
            coefficientOfVariation: mean > 0 ? Math.sqrt(variance) / mean : 0,
            recentAverageDailyCredits: recent.reduce((a, b) => a + b, 0) / recent.length,
            recentDayCount: recent.length };
    }
    return { summary, history };
}
export async function getAiUsageDashboard(input: {
    channelID: string; customerId: string; planTier: string; accountCreatedAt: Date; window: AiUsageWindow;
}) {
    const request: DashboardRequest = { ...input, accountCreatedAt: input.accountCreatedAt.toISOString(),
        window: { ...input.window, startTimestamp: input.window.startTimestamp.toISOString(), endTimestampExclusive: input.window.endTimestampExclusive.toISOString() } };
    const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const now = new Date();
    const existing = await Dashboards.findOne({ key }).lean().exec();
    if (existing && !existing.dirty && now.getTime() - existing.refreshedAt.getTime() < 60_000) {
        return { ...existing.data, refreshedAt: existing.refreshedAt.toISOString(), cached: true };
    }
    return withAiUsageLock(input.channelID, input.customerId, async () => {
        const data = await computeDashboard(request);
        await Dashboards.updateOne({ key }, { $set: { ...input, window: undefined, key, request, data,
            dirty: false, refreshedAt: now, expiresAt: new Date(now.getTime() + DAY) } }, { upsert: true });
        return { ...data, refreshedAt: now.toISOString(), cached: false };
    });
}
export async function refreshAiUsageDashboards(limit = 20): Promise<number> {
    const now = new Date();
    const docs = await Dashboards.find({ expiresAt: { $gt: now }, $or: [{ dirty: true }, { refreshedAt: { $lte: new Date(now.getTime() - 60_000) } }] })
        .sort({ refreshedAt: 1 }).limit(limit).lean().exec();
    for (const doc of docs) {
        await withAiUsageLock(doc.channelID, doc.customerId, async () => {
            const data = await computeDashboard(doc.request as DashboardRequest);
            await Dashboards.updateOne({ _id: doc._id }, { $set: { data, dirty: false, refreshedAt: new Date() } });
        });
    }
    return docs.length;
}
