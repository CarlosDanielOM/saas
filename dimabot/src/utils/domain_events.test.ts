import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import { buildDomainEventKey, journalDomainEvent } from './domain_events.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { DomainEventWakeups, domainEventWakeups } from './domain_event_wakeups.js';
import { DomainEventContractError, validateDomainEventContract } from '../domain_events/domain_event_contracts.js';
import { normalizeTwitchEventsubDomainEvent } from '../domain_events/twitch_eventsub_events.js';
import { normalizePolarDomainEvent } from '../domain_events/polar_events.js';

test('domain event keys encode delimiter-bearing components without collisions', () => {
    assert.notEqual(
        buildDomainEventKey('a:b', 'c', 'd'),
        buildDomainEventKey('a', 'b:c', 'd')
    );
    assert.equal(buildDomainEventKey('twitch', 'message-1', 'stream.started'), 'twitch:message-1:stream.started');
});

test('direct journal calls reject malformed known contracts and future versions before database access', async (context) => {
    context.mock.method(DomainEventSchema, 'init', (() => assert.fail('Unexpected database init')) as never);
    context.mock.method(DomainEventSchema.collection, 'insertOne', (() => assert.fail('Unexpected database write')) as never);
    context.mock.method(domainEventWakeups, 'publish', () => assert.fail('Unexpected wakeup'));
    const twitch = normalizeTwitchEventsubDomainEvent({ messageId: 'receipt', subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: 'channel', user_id: 'follower' } })!;
    const polar = normalizePolarDomainEvent({ webhookId: 'receipt', event: { type: 'order.paid', timestamp: new Date(), data: { id: 'order', customerId: 'customer', status: 'paid', paid: true } } });
    for (const input of [twitch, polar]) {
        await assert.rejects(journalDomainEvent({ ...input, payload: {} }), DomainEventContractError);
        await assert.rejects(journalDomainEvent({ ...input, schemaVersion: 2 }), DomainEventContractError);
        await assert.rejects(journalDomainEvent({ ...input, subject: undefined }), DomainEventContractError);
    }
    const retainedLooking = {
        ...twitch, subject: undefined, _id: new Types.ObjectId(), eventKey: 'twitch-eventsub:receipt:channel.follow.received',
        occurredAt: new Date(), journaledAt: new Date(), expiresAt: new Date()
    };
    await assert.rejects(journalDomainEvent(retainedLooking), DomainEventContractError);
});

test('a follow with no provider timestamps is journaled at now without inventing a payload timestamp', async (context) => {
    context.mock.method(DomainEventSchema, 'init', (async () => DomainEventSchema) as never);
    context.mock.method(DomainEventSchema.collection, 'insertOne', (async () => ({ acknowledged: true })) as never);
    context.mock.method(domainEventWakeups, 'publish', () => undefined);
    const before = Date.now();
    const result = await journalDomainEvent(normalizeTwitchEventsubDomainEvent({
        messageId: 'receipt', subscription: { type: 'channel.follow' },
        event: { broadcaster_user_id: 'channel', user_id: 'follower' }
    })!);
    assert.ok(result.event.occurredAt.getTime() >= before && result.event.occurredAt.getTime() <= Date.now());
    assert.equal((result.event.payload.event as Record<string, unknown>).followed_at, undefined);
    validateDomainEventContract(result.event);
});

test('journalDomainEvent rejects an invalid occurrence time before database access', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'test',
        sourceEventId: 'invalid-date',
        type: 'test.invalid-date',
        topic: 'channel',
        channelID: 'channel-1',
        occurredAt: 'not-a-date',
        payload: {}
    }), /occurredAt must be a valid date/);
});

test('journalDomainEvent rejects non-finite numeric settings before database access', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'test',
        sourceEventId: 'invalid-retention',
        type: 'test.invalid-retention',
        topic: 'channel',
        channelID: 'channel-1',
        retentionSeconds: Number.NaN,
        payload: {}
    }), /must be finite numbers/);
});

test('channel events still require their provider channel ID', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'twitch-eventsub', sourceEventId: 'missing-channel', topic: 'channel',
        type: 'stream.started', payload: {}
    }), /channelID is required/);
});

test('provider-neutral events require an owner or subject identity', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'polar', sourceEventId: 'missing-owner', topic: 'domain',
        type: 'billing.order.paid', channelID: 'not-an-owner', payload: {}
    }), /requires a subject or owner identity/);
});

test('owner identity cannot be a provider channel ID', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'polar', sourceEventId: 'bad-owner', topic: 'domain',
        type: 'billing.order.paid', ownerUserId: '12345', payload: {}
    }), /ownerUserId must be an internal user ObjectId/);
});

test('dispatch recovery marker is persisted in the original journal insert', async (context) => {
    context.mock.method(domainEventWakeups, 'publish', () => assert.fail('No hint before Mongo acceptance'));
    const stopBeforeWakeup = new Error('Stop after inspecting the insert');
    context.mock.method(DomainEventSchema, 'init', (async () => DomainEventSchema) as never);
    context.mock.method(DomainEventSchema.collection, 'insertOne', (async (document: Record<string, unknown>, options: unknown) => {
        assert.equal(document.dispatchPending, true);
        assert.deepEqual(document.subject, { provider: 'polar', kind: 'customer', id: 'customer-1' });
        assert.deepEqual(options, { writeConcern: { w: 1, j: true } });
        throw stopBeforeWakeup;
    }) as never);

    await assert.rejects(journalDomainEvent({
        source: 'polar-webhook', sourceEventId: 'receipt-1', topic: 'domain',
        type: 'billing.order.paid', subject: { provider: 'polar', kind: 'customer', id: 'customer-1' },
        occurredAt: new Date('2026-09-04T10:00:00Z'), metadata: { originalEventType: 'order.paid' },
        payload: { customerId: 'customer-1', orderId: 'order-1', status: 'paid', paid: true }
    }), (error) => error === stopBeforeWakeup);
});

test('journal acceptance and duplicate receipts require only Mongo, never a cache wakeup', async (context) => {
    const publish = context.mock.method(domainEventWakeups, 'publish', () => undefined);
    const input = {
        source: 'test', sourceEventId: 'receipt', topic: 'channel' as const,
        type: 'test.accepted', channelID: 'channel', payload: {}
    };
    let stored: Record<string, unknown>;
    context.mock.method(DomainEventSchema, 'init', (async () => DomainEventSchema) as never);
    context.mock.method(DomainEventSchema.collection, 'insertOne', (async (document: Record<string, unknown>) => {
        if (stored) throw Object.assign(new Error('Duplicate receipt'), { code: 11000 });
        stored = document;
        return { acknowledged: true };
    }) as never);
    context.mock.method(DomainEventSchema, 'findOne', (async () => new DomainEventSchema(stored)) as never);
    const first = await journalDomainEvent(input);
    const duplicate = await journalDomainEvent(input);
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(first.event.eventKey, duplicate.event.eventKey);
    assert.deepEqual(Object.keys(first).sort(), ['event', 'inserted']);
    assert.equal(publish.mock.callCount(), 2, 'duplicates can also prompt recovery');
});

for (const stuck of ['connect', 'publish'] as const) {
    test(`Mongo acceptance returns while cache ${stuck} never resolves`, { timeout: 2000 }, async (context) => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const previous = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
        process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = 'true';
        context.after(() => {
            if (previous === undefined) delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
            else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = previous;
        });
        let connects = 0;
        let publications = 0;
        let destroys = 0;
        const wakeups = new DomainEventWakeups({
            timeoutMs: 50,
            createClient: () => ({
                connect: () => { connects++; return stuck === 'connect' ? new Promise(() => {}) : Promise.resolve(); },
                publish: () => { publications++; return new Promise(() => {}); },
                subscribe: async () => undefined,
                on: () => undefined,
                destroy: () => { destroys++; }
            })
        });
        context.after(() => wakeups.stop());
        context.mock.method(domainEventWakeups, 'publish', () => wakeups.publish());
        context.mock.method(DomainEventSchema, 'init', (async () => DomainEventSchema) as never);
        context.mock.method(DomainEventSchema.collection, 'insertOne', (async () => ({ acknowledged: true })) as never);
        const input = {
            source: 'test', sourceEventId: 'cache-stuck', topic: 'channel' as const,
            type: 'test.accepted', channelID: 'channel', payload: {}
        };
        assert.equal((await journalDomainEvent(input)).inserted, true);
        assert.equal(connects, 0, 'cold cache initialization is scheduled after ACK');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(connects, 1);
        assert.equal(publications, stuck === 'publish' ? 1 : 0);
        assert.equal((await journalDomainEvent({ ...input, sourceEventId: 'second' })).inserted, true);
        assert.equal(destroys, 0, 'Mongo acceptance did not wait even for the cache timeout');
        context.mock.timers.tick(50);
        assert.equal(destroys, 1, 'the background lifecycle is still bounded');
    });
}
