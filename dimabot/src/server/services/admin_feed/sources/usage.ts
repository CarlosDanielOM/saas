import AiUsageReceiptSchema, { type IAiUsageReceipt } from '../../../../schemas/ai_usage_receipt.schema.js';
import { actorOf, emptyCounts, flatData, loginOnly, mongoPage, num, str, servedKinds, type FeedSource } from '../source.js';
import type { FeedFilters, FeedItem, FeedKind } from '../types.js';

/**
 * AI usage receipts (`ai_usage_receipts`): voice requests, other AI work, and credit adjustments.
 * Receipts are written for successes only. Chat protection reviews also leave a receipt; they are already
 * in the feed as `protection`, so they are left out here.
 *
 * Indexes: `{occurredAt, entryId}` (every channel), `{category, occurredAt, entryId}` (voice), the partial
 * `{actorId, occurredAt, entryId}` (one chatter) and `{channelID, customerId, occurredAt, entryId}` (one
 * channel, with its customer ids looked up first so the index order holds).
 */
const OWN_KINDS: readonly FeedKind[] = ['voice', 'ai', 'credits'];
export const MODERATION_OPERATION = 'contextual_moderation';

const KIND_MATCH: Record<'voice' | 'ai' | 'credits', Record<string, unknown>> = {
    voice: { entryKind: 'usage', category: 'tts' },
    ai: { entryKind: 'usage', category: { $ne: 'tts' }, operation: { $ne: MODERATION_OPERATION } },
    credits: { entryKind: 'adjustment' }
};

export function usageKind(row: Pick<IAiUsageReceipt, 'entryKind' | 'category'>): 'voice' | 'ai' | 'credits' {
    if (row.entryKind === 'adjustment') return 'credits';
    return row.category === 'tts' ? 'voice' : 'ai';
}

export function usageFilter(filters: FeedFilters, kinds: FeedKind[], now: Date, customerIds?: string[]): Record<string, unknown> {
    const wanted = kinds.filter((kind): kind is keyof typeof KIND_MATCH => kind in KIND_MATCH);
    // One kind: plain equality, so the category index applies. Several: exclude the rest (no top-level $or,
    // which would make the planner give up the time order).
    const filter: Record<string, unknown> = wanted.length === 1
        ? { ...KIND_MATCH[wanted[0]] }
        : { $nor: [{ operation: MODERATION_OPERATION }, ...(Object.keys(KIND_MATCH) as Array<keyof typeof KIND_MATCH>).filter(kind => !wanted.includes(kind)).map(kind => KIND_MATCH[kind])] };
    filter.expiresAt = { $gt: now };
    if (filters.channelID) {
        filter.channelID = filters.channelID;
        if (customerIds) filter.customerId = { $in: customerIds };
    }
    // `$type` repeats the partial index's own filter: without it the planner does not see the index applies.
    if (filters.actorID) filter.actorId = { $eq: filters.actorID, $type: 'string' };
    else if (filters.actorLogin) filter.actorLogin = filters.actorLogin;
    return filter;
}

export function usageItem(row: IAiUsageReceipt): FeedItem {
    const kind = usageKind(row);
    const quantity = num(row.quantity);
    const cost = num(row.costUsd);
    const name = kind === 'voice' ? row.provider : kind === 'ai' ? row.operation : str(row.adjustmentType) ?? row.operation;
    const data = kind === 'voice'
        ? { provider: row.provider, chars: row.unit === 'characters' ? quantity : null, source: row.source, voice: row.voice, model: row.model }
        : kind === 'ai'
            ? { category: row.category, operation: row.operation, provider: row.provider, model: row.model, tokens: row.unit === 'tokens' ? quantity : null, source: row.source }
            : { adjustmentType: row.adjustmentType, source: row.source };
    return {
        id: `usage:${row.entryId}`,
        at: new Date(row.occurredAt).toISOString(),
        kind,
        name: name || kind,
        outcome: 'ok',
        reason: null,
        channelID: row.channelID || null,
        channel: null,
        actor: actorOf(row.actorId, row.actorLogin, row.actorName),
        text: null,
        credits: num(row.credits),
        providerUSD: cost,
        durationMs: null,
        data: flatData(data),
        ref: { type: 'usage', id: row.entryId }
    };
}

async function channelCustomers(channelID: string, maxTimeMS: number): Promise<string[]> {
    const ids = await AiUsageReceiptSchema.collection.distinct('customerId', { channelID }, { maxTimeMS });
    return ids.filter((id): id is string => typeof id === 'string');
}

const PROJECTION = {
    _id: 0, channelID: 1, entryId: 1, occurredAt: 1, entryKind: 1, category: 1, operation: 1, source: 1, adjustmentType: 1,
    provider: 1, model: 1, quantity: 1, unit: 1, credits: 1, actorId: 1, actorLogin: 1, actorName: 1, costUsd: 1, voice: 1
};

export const usageSource: FeedSource = {
    prefix: 'usage',
    plan(filters) {
        if (filters.outcome) return [];
        // `actorLogin` has no index: a chatter by login is only searched inside one channel.
        if (loginOnly(filters) && !filters.channelID) return [];
        return servedKinds(filters, OWN_KINDS);
    },
    gaps: filters => !filters.outcome && loginOnly(filters) && !filters.channelID ? servedKinds(filters, OWN_KINDS) : [],
    async list({ filters, kinds, bound, limit, now, maxTimeMS }) {
        const customers = filters.channelID ? await channelCustomers(filters.channelID, maxTimeMS) : undefined;
        if (customers && !customers.length) return [];
        const rows = await mongoPage(AiUsageReceiptSchema.collection, usageFilter(filters, kinds, now, customers), {
            timeField: 'occurredAt', idField: 'entryId', from: filters.from, to: filters.to, bound, limit, maxTimeMS, projection: PROJECTION
        });
        return rows.map(row => usageItem(row as unknown as IAiUsageReceipt));
    },
    async count({ filters, kinds, now, maxTimeMS }) {
        const counts = emptyCounts(kinds);
        const rows = await AiUsageReceiptSchema.collection.aggregate([
            { $match: { ...usageFilter(filters, kinds, now), occurredAt: { $gte: filters.from, $lt: filters.to } } },
            { $group: {
                _id: { $cond: [{ $eq: ['$entryKind', 'adjustment'] }, 'credits', { $cond: [{ $eq: ['$category', 'tts'] }, 'voice', 'ai'] }] },
                n: { $sum: 1 }
            } }
        ], { maxTimeMS }).toArray();
        for (const row of rows) {
            const entry = counts.get(row._id as FeedKind);
            if (entry) entry.total = row.n;
        }
        return [...counts.values()];
    }
};
