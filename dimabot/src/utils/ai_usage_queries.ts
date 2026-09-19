import { createHash } from 'node:crypto';
import Receipts from '../schemas/ai_usage_receipt.schema.js';
import { ADJUSTMENT_TYPES, classifyAdjustment } from './ai_usage_classification.js';
import { AiUsageReceiptValidationError, type AiUsageWindow } from './ai_usage_receipts.js';
import { getAiUsageLedgerStatus } from './ai_usage_ledger.js';
import { enqueueAiUsageBackfill } from './ai_usage_backfill_queue.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';

export async function usageLedgerStatus(input: { channelID: string; customerId: string; planTier: string; window: AiUsageWindow }) {
    const ledger = await getAiUsageLedgerStatus({ ...input, startsAt: input.window.startTimestamp });
    if (ledger.status === 'pending') {
        const cache = await getDragonflyClient('AiUsageRead');
        await enqueueAiUsageBackfill(cache, input);
    }
    return ledger;
}
export interface TransactionFilters {
    category?: string; source?: string; resourceId?: string; requestId?: string;
    entryKind?: string; adjustmentType?: string; cursor?: string; limit?: number;
}
export async function queryAiUsageTransactions(input: TransactionFilters & {
    channelID: string; customerId: string; window: AiUsageWindow;
}) {
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AiUsageReceiptValidationError('limit must be between 1 and 100');
    const categories = ['tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation', 'credit_adjustment', 'other', 'uncategorized'];
    if (input.category && !categories.includes(input.category)) throw new AiUsageReceiptValidationError('Invalid usage category');
    if (input.entryKind && !['usage', 'adjustment'].includes(input.entryKind)) throw new AiUsageReceiptValidationError('Invalid entry kind');
    if (input.adjustmentType && !ADJUSTMENT_TYPES.includes(input.adjustmentType as any)) throw new AiUsageReceiptValidationError('Invalid adjustment type');
    const filters: Record<string, string> = {};
    for (const field of ['category', 'source', 'resourceId', 'requestId', 'entryKind', 'adjustmentType'] as const) {
        const value = input[field];
        if (value) {
            if (value.length > 128 || !/^[a-zA-Z0-9_.:/-]+$/.test(value)) throw new AiUsageReceiptValidationError(`Invalid ${field}`);
            filters[field] = value;
        }
    }
    const scope = createHash('sha256').update(JSON.stringify([
        input.channelID, input.customerId, input.window.startTimestamp, input.window.endTimestampExclusive, filters
    ])).digest('hex');
    const query: Record<string, any> = {
        channelID: input.channelID, customerId: input.customerId, ...filters,
        occurredAt: { $gte: input.window.startTimestamp, $lt: input.window.endTimestampExclusive },
        expiresAt: { $gt: new Date() }
    };
    if (input.cursor) {
        try {
            if (input.cursor.length > 2048) throw new Error();
            const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
            if (typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 128 || typeof cursor.at !== 'string'
                || !Number.isFinite(new Date(cursor.at).getTime()) || (cursor.scope && cursor.scope !== scope)) throw new Error();
            const at = new Date(cursor.at);
            query.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, entryId: { $lt: cursor.id } }];
        } catch { throw new AiUsageReceiptValidationError('Invalid transaction cursor for this query'); }
    }
    const docs = await Receipts.find(query).sort({ occurredAt: -1, entryId: -1 }).limit(limit + 1).lean().exec();
    const items = docs.slice(0, limit).map(doc => ({
        id: doc.entryId, requestId: doc.requestId, occurredAt: doc.occurredAt.toISOString(),
        entryKind: doc.entryKind, category: doc.category, operation: doc.operation,
        source: doc.source || null, adjustmentType: doc.adjustmentType || classifyAdjustment(doc),
        provider: doc.provider, model: doc.model, quantity: doc.quantity, unit: doc.unit, credits: doc.credits,
        resourceType: doc.resourceType, resourceId: doc.resourceId, itemized: doc.itemized
    }));
    const last = items.at(-1);
    return {
        items,
        nextCursor: docs.length > limit && last
            ? Buffer.from(JSON.stringify({ v: 2, id: last.id, at: last.occurredAt, scope })).toString('base64url') : null
    };
}
