import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order } from '@polar-sh/sdk/models/components/order.js';
import type { OrderSubscription } from '@polar-sh/sdk/models/components/ordersubscription.js';
import type { Subscription } from '@polar-sh/sdk/models/components/subscription.js';
import { CustomerStateMeter$inboundSchema } from '@polar-sh/sdk/models/components/customerstatemeter.js';
import UsersSchema from '../schemas/users.schema.js';
import { normalizePolarDomainEvent, polarWebhookProducer, type NormalizePolarWebhookInput } from './polar_events.js';
import { DomainEventContractError } from './domain_event_contracts.js';

const timestamp = new Date('2026-09-04T10:00:00Z');
const periodEnd = new Date('2027-09-04T10:00:00Z');
const externalId = '0123456789abcdef01234567';
const order = {
    id: 'order-1', customerId: 'customer-1', productId: 'product-1',
    subscriptionId: 'subscription-1', paid: true, status: 'paid'
} satisfies Partial<Order>;
const subscription = {
    id: 'subscription-1', customerId: 'customer-1', productId: 'product-1',
    status: 'active', recurringInterval: 'year', currentPeriodEnd: periodEnd,
    endsAt: null, endedAt: null
} satisfies Partial<Subscription> & Partial<OrderSubscription>;

function input(type: string, data: unknown): NormalizePolarWebhookInput {
    return { webhookId: 'signed-webhook-1', event: { type, timestamp, data } };
}

test('normalizes SDK camelCase paid order and nested Date without retaining PII or guessing a channel', () => {
    const event = normalizePolarDomainEvent(input('order.paid', {
        ...order, subscription,
        customer: { id: 'customer-1', externalId, email: 'private@example.test', metadata: { twitch_id: 'twitch-1' } },
        metadata: { twitch_id: 'twitch-2', externalId: 'not-the-owner' },
        product: { name: 'Monthly Premium' }, billingName: 'Private Name'
    }));

    assert.deepEqual(event, {
        source: 'polar-webhook', sourceEventId: 'signed-webhook-1', type: 'billing.order.paid',
        topic: 'domain', schemaVersion: 1,
        subject: { provider: 'polar', kind: 'customer', id: 'customer-1' },
        occurredAt: timestamp,
        payload: {
            customerId: 'customer-1', orderId: 'order-1', productId: 'product-1', subscriptionId: 'subscription-1',
            paid: true, status: 'paid', cadence: 'yearly', periodEnd: periodEnd.toISOString()
        },
        metadata: { originalEventType: 'order.paid', externalCustomerId: externalId }
    });
    assert.equal('channelID' in event, false);
    assert.equal(polarWebhookProducer.provider, 'polar');
    assert.equal(polarWebhookProducer.normalize, normalizePolarDomainEvent);
});

test('one-time orders omit absent subscription, product, and cadence instead of using product names', () => {
    const event = normalizePolarDomainEvent(input('order.paid', {
        ...order, subscriptionId: null, productId: null, subscription: null,
        product: { name: 'Yearly Pro' }, metadata: { twitch_id: 'twitch-1' }
    }));
    assert.deepEqual(event.payload, { customerId: 'customer-1', orderId: 'order-1', paid: true, status: 'paid' });
    assert.deepEqual(event.metadata, { originalEventType: 'order.paid' });
});

test('retains the shipped legacy Twitch ownership hint without using it as an internal owner or channel', () => {
    const event = normalizePolarDomainEvent(input('order.paid', {
        ...order, subscription,
        customer: { metadata: { twitch_user_id: 'legacy-twitch-id' } }
    }));
    assert.equal(event.metadata?.legacyTwitchChannelId, 'legacy-twitch-id');
    assert.equal(event.ownerUserId, undefined);
    assert.equal(event.channelID, undefined);
    assert.deepEqual(event.subject, { provider: 'polar', kind: 'customer', id: 'customer-1' });
});

test('paid boolean is authoritative without imposing another order-status gate', () => {
    assert.equal(normalizePolarDomainEvent(input('order.paid', {
        ...order, subscription, status: 'partially_refunded'
    })).payload.status, 'partially_refunded');
    for (const paid of [false, undefined, 'true', 1]) {
        assert.throws(() => normalizePolarDomainEvent(input('order.paid', { ...order, subscription, paid })), /paid=true/);
    }
});

test('subscription updates normalize monthly cadence and retain no plan decisions or customer PII', () => {
    const event = normalizePolarDomainEvent(input('subscription.updated', {
        ...subscription, recurringInterval: 'month',
        customer: { externalId, email: 'private@example.test' }, product: { name: 'Yearly Pro' }
    }));
    assert.equal(event.type, 'billing.subscription.updated');
    assert.deepEqual(event.payload, {
        customerId: 'customer-1', subscriptionId: 'subscription-1', productId: 'product-1',
        status: 'active', cadence: 'monthly', periodEnd: periodEnd.toISOString()
    });
    assert.deepEqual(event.metadata, { originalEventType: 'subscription.updated', externalCustomerId: externalId });
});

test('canceled subscription cutoff prefers endsAt, then endedAt, then currentPeriodEnd', () => {
    const endsAt = new Date('2026-10-04T10:00:00Z');
    const endedAt = new Date('2026-09-05T10:00:00Z');
    for (const [dates, expected] of [
        [{ endsAt, endedAt }, endsAt.toISOString()],
        [{ endsAt: null, endedAt }, endedAt.toISOString()],
        [{ endsAt: null, endedAt: null }, periodEnd.toISOString()],
        [{ endsAt: null, endedAt: null, currentPeriodEnd: null }, null]
    ] as const) {
        assert.equal(normalizePolarDomainEvent(input('subscription.updated', {
            ...subscription, status: 'canceled', ...dates
        })).payload.periodEnd, expected);
    }
});

test('active subscriptions keep current period end even when cancellation dates exist', () => {
    assert.equal(normalizePolarDomainEvent(input('subscription.updated', {
        ...subscription, endsAt: new Date('2026-10-04T10:00:00Z'), cancelAtPeriodEnd: true
    })).payload.periodEnd, periodEnd.toISOString());
});

test('missing or unsupported subscription intervals never silently become monthly', () => {
    for (const recurringInterval of [undefined, null, '', 'week', 'day']) {
        for (const event of [
            input('order.paid', { ...order, subscription: { ...subscription, recurringInterval } }),
            input('subscription.updated', { ...subscription, recurringInterval })
        ]) assert.throws(() => normalizePolarDomainEvent(event), /recurringInterval/);
    }
    assert.throws(() => normalizePolarDomainEvent(input('order.paid', { ...order, subscription: null })), /recurringInterval/);
});

test('nested SDK dates must be finite Date instances, with null preserved', () => {
    for (const currentPeriodEnd of [new Date(NaN), periodEnd.toISOString(), 123]) {
        assert.throws(() => normalizePolarDomainEvent(input('order.paid', {
            ...order, subscription: { ...subscription, currentPeriodEnd }
        })), /finite Date/);
        assert.throws(() => normalizePolarDomainEvent(input('subscription.updated', {
            ...subscription, currentPeriodEnd
        })), /finite Date/);
    }
    assert.equal(normalizePolarDomainEvent(input('order.paid', {
        ...order, subscription: { ...subscription, currentPeriodEnd: null }
    })).payload.periodEnd, null);
});

test('SDK parsed customer meters map camelCase to snake_case without unit or balance conversion', () => {
    const meter = CustomerStateMeter$inboundSchema.parse({
        id: 'customer-meter-1', created_at: timestamp.toISOString(), modified_at: null,
        meter_id: 'meter-1', consumed_units: 12.5, credited_units: 10, balance: -2.5
    });
    const event = normalizePolarDomainEvent(input('customer.state_changed', {
        id: 'customer-1', externalId, activeMeters: [meter], email: 'private@example.test',
        metadata: { twitch_id: 'twitch-1' }, activeSubscriptions: [subscription]
    }));
    assert.equal(event.type, 'billing.customer.state.changed');
    assert.deepEqual(event.subject, { provider: 'polar', kind: 'customer', id: 'customer-1' });
    assert.deepEqual(event.payload, {
        customerId: 'customer-1',
        meters: [{ meter_id: 'meter-1', consumed_units: 12.5, credited_units: 10, balance: -2.5 }]
    });
    assert.deepEqual(event.metadata, { originalEventType: 'customer.state_changed', externalCustomerId: externalId });
});

test('customer meters preserve zero, empty lists, and omitted optional units', () => {
    assert.deepEqual(normalizePolarDomainEvent(input('customer.state_changed', {
        id: 'customer-1', activeMeters: [{ meterId: 'meter-1', balance: 0 }]
    })).payload.meters, [{ meter_id: 'meter-1', balance: 0 }]);
    assert.deepEqual(normalizePolarDomainEvent(input('customer.state_changed', {
        id: 'customer-1', activeMeters: []
    })).payload.meters, []);
});

test('rejects malformed meters and all nonfinite or nonnumeric units', () => {
    for (const field of ['consumedUnits', 'creditedUnits', 'balance']) {
        for (const value of [NaN, Infinity, -Infinity, '12', null]) {
            assert.throws(() => normalizePolarDomainEvent(input('customer.state_changed', {
                id: 'customer-1', activeMeters: [{ meterId: 'meter-1', [field]: value }]
            })), /finite/);
        }
    }
    for (const activeMeters of [undefined, null, {}, [null], [{ meterId: '' }]]) {
        assert.throws(() => normalizePolarDomainEvent(input('customer.state_changed', { id: 'customer-1', activeMeters })));
    }
});

test('unmapped SDK events retain JSON-safe provider data and a real resource subject', async () => {
    const data = { id: 'product-1', createdAt: timestamp, nested: { dates: [periodEnd] }, name: 'New Product' };
    const event = normalizePolarDomainEvent(input('product.created', data));
    assert.equal(event.type, 'provider.polar.product.created');
    assert.equal(event.sourceEventId, 'signed-webhook-1');
    assert.deepEqual(event.subject, { provider: 'polar', kind: 'resource', id: 'product-1' });
    assert.deepEqual(event.metadata, { originalEventType: 'product.created', unmapped: true });
    assert.deepEqual(event.payload, { providerData: {
        id: 'product-1', createdAt: timestamp.toISOString(), nested: { dates: [periodEnd.toISOString()] }, name: 'New Product'
    } });
    assert.equal('channelID' in event, false);
    assert.equal('ownerUserId' in event, false);
    assert.equal(await polarWebhookProducer.resolveOwner!(event), undefined);
    assert.ok(data.createdAt instanceof Date);
});

test('unmapped SDK normalization rejects lossy JSON instead of silently laundering invalid values', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, () => {}, new Date(NaN), cycle, Object.create({ inherited: true })]) {
        assert.throws(() => normalizePolarDomainEvent(input('product.created', { id: 'product', value })), DomainEventContractError);
    }
    const data = { id: 'product', absentSdkField: undefined, createdAt: timestamp };
    assert.deepEqual(normalizePolarDomainEvent(input('product.created', data)).payload, {
        providerData: { id: 'product', createdAt: timestamp.toISOString() }
    });
    assert.ok('absentSdkField' in data, 'SDK serialization does not mutate its input');
});

test('unmapped customer-related events retain customer identity but are not promoted to billing', () => {
    for (const [type, data] of [
        ['order.refunded', { id: 'order-1', customerId: 'customer-1', customer: { externalId } }],
        ['customer.updated', { id: 'customer-1', externalId }],
        ['checkout.updated', { id: 'checkout-1', customer: { id: 'customer-1', externalId } }]
    ] as const) {
        const event = normalizePolarDomainEvent(input(type, data));
        assert.equal(event.type, `provider.polar.${type}`);
        assert.deepEqual(event.subject, { provider: 'polar', kind: 'customer', id: 'customer-1' });
        assert.deepEqual(event.metadata, { originalEventType: type, externalCustomerId: externalId, unmapped: true });
        assert.deepEqual(event.payload, { providerData: data });
    }
});

test('requires signed delivery identity, event type, top-level Date timestamp, record data, and resource ID', () => {
    const valid = input('product.created', { id: 'product-1' });
    const invalid: unknown[] = [
        ...[undefined, '', ' ', 123].map(webhookId => ({ ...valid, webhookId })),
        ...[undefined, '', ' ', 123].map(type => ({ ...valid, event: { ...valid.event, type } })),
        ...[undefined, null, new Date(NaN), timestamp.toISOString(), 123].map(timestamp => ({ ...valid, event: { ...valid.event, timestamp } })),
        ...[undefined, null, [], 'data', new Date(), {}, { id: '' }, { id: 123 }, { customerId: 'customer-1' }]
            .map(data => ({ ...valid, event: { ...valid.event, data } }))
    ];
    for (const value of invalid) {
        assert.throws(() => normalizePolarDomainEvent(value as NormalizePolarWebhookInput), /Polar webhook requires/);
    }
});

test('known billing events require their own camelCase customer and resource identities', () => {
    for (const type of ['order.paid', 'subscription.updated']) {
        const data = type === 'order.paid' ? { ...order, subscription } : subscription;
        for (const field of ['id', 'customerId']) {
            assert.throws(() => normalizePolarDomainEvent(input(type, {
                ...data, [field]: undefined, customer_id: 'raw-customer', customer: { id: 'nested-customer' }
            })), /requires/);
        }
    }
    assert.throws(() => normalizePolarDomainEvent(input('subscription.updated', { ...subscription, productId: undefined })), /productId/);
});

test('producer delegates customer ownership using the actual externalId with mocked identity queries', async (t) => {
    const findOne = t.mock.method(UsersSchema, 'findOne', (() => ({
        select: () => ({ lean: async () => null })
    })) as unknown as typeof UsersSchema.findOne);
    const findById = t.mock.method(UsersSchema, 'findById', (() => ({
        select: () => ({ lean: async () => ({ _id: externalId, polar_sh_customer_id: null }) })
    })) as unknown as typeof UsersSchema.findById);
    const event = normalizePolarDomainEvent(input('customer.state_changed', {
        id: 'customer-1', externalId, activeMeters: [], metadata: { twitch_id: 'twitch-1' }
    }));
    assert.equal(await polarWebhookProducer.resolveOwner!(event), externalId);
    assert.deepEqual(findOne.mock.calls[0].arguments, [{ polar_sh_customer_id: 'customer-1' }]);
    assert.deepEqual(findById.mock.calls[0].arguments, [externalId]);
});
