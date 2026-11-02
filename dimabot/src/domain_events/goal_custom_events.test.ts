import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { customGoalProducer, ingestCustomGoalContribution } from './goal_custom_events.js';
import { validateDomainEventContract } from './domain_event_contracts.js';
import { DOMAIN_EVENT_CONSUMERS } from './domain_event_consumers.js';
const base = { channelID: '123', receiptIdentity: 'scope:receipt', itemKey: 'sticker', quantity: 3, occurredAt: new Date('2026-01-01T00:00:00Z') };
test('custom goal contract scopes identity by channel and validates payloads', () => {
    const event = customGoalProducer.normalize(base)!;
    validateDomainEventContract(event, 'ingest');
    assert.notEqual(event.sourceEventId, customGoalProducer.normalize({ ...base, channelID: '456' })!.sourceEventId);
    assert.equal(event.sourceEventId, customGoalProducer.normalize({ ...base, itemKey: 'other', quantity: 2 })!.sourceEventId);
    for (const update of [{ itemKey: 'invalid-key' }, { quantity: 0 }, { quantity: 1e9 + 1 }]) assert.throws(() => customGoalProducer.normalize({ ...base, ...update }));
    assert.throws(() => validateDomainEventContract({ ...event, payload: { itemKey: 'sticker', quantity: 0 } }, 'ingest'));
});
test('duplicate receipt with a different payload is rejected', async () => {
    const normalized = customGoalProducer.normalize(base)!;
    const previous = { ...normalized, _id: new Types.ObjectId(), eventKey: 'key', journaledAt: new Date(), expiresAt: new Date(), occurredAt: base.occurredAt };
    const journal = (async () => ({ event: previous, inserted: false })) as any;
    const check = async () => {};
    assert.equal((await ingestCustomGoalContribution(base, journal, check)).inserted, false);
    await assert.rejects(ingestCustomGoalContribution({ ...base, quantity: 4 }, journal, check), /conflicts/);
    await assert.rejects(ingestCustomGoalContribution({ ...base, itemKey: 'other' }, journal, check), /conflicts/);
});
test('custom goal consumer is isolated from Twitch goal consumer', () => {
    const consumer = DOMAIN_EVENT_CONSUMERS.find(c => c.consumer === 'goal-custom-contributions-v1')!;
    assert.deepEqual(consumer.topics, ['domain']);
    assert.deepEqual(consumer.eventFilter, { source: 'goals-custom', type: 'goal.item.added' });
    assert.equal(consumer.adminReplay, true);
});

test('permanent receipt conflict is checked before journal ingestion', async () => {
    let ingested = false;
    await assert.rejects(ingestCustomGoalContribution(base, (async () => { ingested = true; throw new Error('unexpected'); }) as any,
        async (_channel, key) => { assert.match(key, /^goals-custom:/); throw new Error('receipt conflict'); }), /receipt conflict/);
    assert.equal(ingested, false);
});
