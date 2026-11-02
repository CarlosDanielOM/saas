import { createHash } from 'node:crypto';
import type { DomainEventProducer, JournalDomainEventResult } from './domain_event.types.js';
import { GoalError } from '../goals/model.js';
import type { ingestDomainEvent } from './domain_event_producers.js';

export interface CustomGoalContribution {
    channelID: string;
    /** Stable trusted origin + configuration path, or explicit integration receipt + action scope. */
    receiptIdentity: string;
    itemKey: string;
    quantity: number;
    occurredAt: Date;
}

export const customGoalProducer: DomainEventProducer<CustomGoalContribution> = {
    provider: 'goals-custom',
    normalize(input) {
        if (!/^\d{1,30}$/.test(input.channelID) || typeof input.receiptIdentity !== 'string'
            || !input.receiptIdentity || input.receiptIdentity.length > 1000
            || !/^[a-z0-9_]{1,48}$/.test(input.itemKey)
            || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000_000
            || !(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
            throw new GoalError('invalid', 'Invalid custom goal contribution');
        }
        const sourceEventId = createHash('sha256').update(JSON.stringify([input.channelID, input.receiptIdentity])).digest('hex');
        return {
            source: 'goals-custom', sourceEventId, type: 'goal.item.added', topic: 'domain', schemaVersion: 1,
            channelID: input.channelID, subject: { provider: 'goals-custom', kind: 'streaming-account', id: input.channelID },
            occurredAt: input.occurredAt, payload: { itemKey: input.itemKey, quantity: input.quantity }, metadata: {}
        };
    }
};

export async function ingestCustomGoalContribution(input: CustomGoalContribution,
    injectedIngest?: typeof ingestDomainEvent,
    injectedCheck?: (channel: string, eventKey: string, itemKey: string, quantity: number) => Promise<void>): Promise<JournalDomainEventResult> {
    const normalized = customGoalProducer.normalize(input)!;
    const { buildDomainEventKey } = await import('../utils/domain_events.js');
    const eventKey = buildDomainEventKey(normalized.source, normalized.sourceEventId, normalized.type);
    const check = injectedCheck || (await import('../goals/service.js')).assertCustomGoalReceiptCompatible;
    await check(input.channelID, eventKey, input.itemKey, input.quantity);
    const ingest = injectedIngest || (await import('./domain_event_producers.js')).ingestDomainEvent;
    const result = await ingest(customGoalProducer, input);
    if (!result) throw new Error('Custom goal contribution was not journaled');
    if (result.event.channelID !== input.channelID || result.event.payload.itemKey !== input.itemKey || result.event.payload.quantity !== input.quantity) {
        throw new GoalError('conflict', 'Custom goal receipt conflicts with an existing contribution', 409);
    }
    return result;
}
