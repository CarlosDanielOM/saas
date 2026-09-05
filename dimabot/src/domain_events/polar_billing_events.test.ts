import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { AI_CREDITS_CACHE_TTL_SECONDS, AI_CREDITS_METER_ID } from '../utils/billing.js';
import { PRODUCT_IDS } from '../utils/referral.js';
import type { DomainEventEnvelope } from './domain_event.types.js';
import type { PolarBillingPayload } from './polar_events.js';
import {
    applyPolarPlanDomainEvent,
    applyPolarCreditsDomainEvent,
    applyPolarRewardDomainEvent,
} from './polar_billing_events.js';

type Dependencies = NonNullable<Parameters<typeof applyPolarPlanDomainEvent>[1]>;
const ownerId = new Types.ObjectId('0123456789abcdef01234567');
const occurredAt = new Date('2026-09-04T10:00:00Z');
const legacyMeterId = '01d90c16-87d0-4e31-880a-4045a8da90cd';
const meters = [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 30, balance: -30 }];

function event(type: string, payload: Partial<PolarBillingPayload> = {}): DomainEventEnvelope {
    return {
        _id: new Types.ObjectId(), eventKey: 'polar-webhook:delivery-1', source: 'polar-webhook',
        sourceEventId: 'delivery-1', type, topic: 'domain', schemaVersion: 1,
        ownerUserId: ownerId.toString(), subject: { provider: 'polar', kind: 'customer', id: 'polar-customer' },
        occurredAt, journaledAt: new Date('2026-09-05T10:00:00Z'),
        expiresAt: new Date('2026-10-05T10:00:00Z'), metadata: {},
        payload: {
            customerId: 'polar-customer', productId: PRODUCT_IDS.PREMIUM,
            orderId: 'order-1', subscriptionId: 'subscription-1', paid: true,
            cadence: 'monthly', status: 'paid', periodEnd: '2026-10-04T10:00:00Z', meters,
            ...payload,
        },
    };
}

function fixture(t: TestContext, twitchIds: string[] = []) {
    const owner = {
        _id: ownerId, plan_tier: 'free', polar_sh_customer_id: 'polar-customer',
        accounts: [
            { type: 'youtube', id: 'youtube-owner' },
            ...twitchIds.map(id => ({ type: 'twitch', id })),
        ],
    } as IUsers;
    const state = {
        owner,
        updated: { ...owner, polar_credit_snapshot: { occurredAt, eventKey: 'polar-webhook:delivery-1', meters } } as IUsers | null,
        latest: owner as IUsers | null,
        exists: true,
    };
    // These query stubs return chosen snapshots, not an emulation of MongoDB matching or atomicity.
    const updateLean = t.mock.fn(async () => state.updated);
    const updateSelect = t.mock.fn((_fields: string) => ({ lean: updateLean }));
    const findLean = t.mock.fn(async () => state.latest);
    const findSelect = t.mock.fn((_fields: string) => ({ lean: findLean }));
    const update = t.mock.method(UsersSchema, 'findOneAndUpdate', (() => ({
        lean: updateLean, select: updateSelect,
    })) as unknown as typeof UsersSchema.findOneAndUpdate);
    const findById = t.mock.method(UsersSchema, 'findById', (() => ({
        lean: findLean, select: findSelect,
    })) as unknown as typeof UsersSchema.findById);
    const exists = t.mock.method(UsersSchema, 'exists', (async () => state.exists ? { _id: ownerId } : null) as unknown as typeof UsersSchema.exists);
    const fakeRedis = {
        eval: t.mock.fn(async (_script: string, _options: { keys: string[]; arguments: string[] }) => 1),
        del: t.mock.fn(async (_keys: string[]) => 1),
    };
    const getOwner = t.mock.fn(async (_event: DomainEventEnvelope) => state.owner);
    const getCache = t.mock.fn(async (_caller?: string) => fakeRedis);
    const applyReward = t.mock.fn(async (_input: Parameters<NonNullable<Dependencies['applyReward']>>[0]) => {});
    const deps: Dependencies = {
        getOwner, getCache: getCache as unknown as Dependencies['getCache'], applyReward,
    };
    function assertNoEffects() {
        for (const mock of [getOwner, getCache, applyReward, update, findById, exists, fakeRedis.eval, fakeRedis.del]) {
            assert.equal(mock.mock.callCount(), 0);
        }
    }
    return { state, deps, getOwner, getCache, applyReward, fakeRedis, update, updateSelect, findById, findSelect, exists, assertNoEffects };
}

for (const type of ['billing.order.paid', 'billing.subscription.updated']) {
    for (const [productId, planTier] of [
        [PRODUCT_IDS.FREE, 'free'], [PRODUCT_IDS.PREMIUM, 'premium'], [PRODUCT_IDS.PRO, 'pro'],
    ] as const) {
        test(`${type} requests ${planTier} for an internal owner without Twitch, using provider-time/key guards`, async t => {
            const f = fixture(t);
            const input = event(type, { productId });
            await applyPolarPlanDomainEvent(input, f.deps);
            assert.deepEqual(f.getOwner.mock.calls[0].arguments, [input]);
            assert.equal(f.update.mock.callCount(), 1);
            assert.deepEqual(f.update.mock.calls[0].arguments, [{
                _id: ownerId,
                $or: [
                    { polar_plan_event_at: { $exists: false } },
                    { polar_plan_event_at: { $lt: occurredAt } },
                    { polar_plan_event_at: occurredAt, polar_plan_event_key: { $lte: input.eventKey } },
                ],
            }, { $set: {
                plan_tier: planTier, plan_tier_until: new Date('2026-10-04T10:00:00Z'),
                polar_plan_event_at: occurredAt, polar_plan_event_key: input.eventKey,
            } }, { new: true }]);
            assert.equal(f.exists.mock.callCount(), 0);
            assert.equal(f.getCache.mock.callCount(), 0);
            assert.equal(f.applyReward.mock.callCount(), 0);
        });
    }
}

test('plan without a period end clears expiry and invalidates only owner Twitch caches', async t => {
    const f = fixture(t, ['twitch-owner-1', 'twitch-owner-2']);
    await applyPolarPlanDomainEvent(event('billing.order.paid', { periodEnd: null }), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, null);
    assert.deepEqual(f.getCache.mock.calls[0].arguments, ['PolarPlanProjection']);
    assert.deepEqual(f.fakeRedis.del.mock.calls.map(call => call.arguments), [[[
        'twitch:accounts', 'accounts:twitch:twitch-owner-1:data', 'accounts:twitch:twitch-owner-2:data',
    ]]]);
    assert.equal(f.fakeRedis.eval.mock.callCount(), 0);
});

test('stale plan update with an existing owner still invalidates cache for retry', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.updated = null;
    await applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps);
    assert.deepEqual(f.exists.mock.calls[0].arguments, [{ _id: ownerId }]);
    assert.equal(f.update.mock.callCount(), 1);
    assert.equal(f.fakeRedis.del.mock.callCount(), 1);
});

test('owner disappearing during plan update rejects before cache work', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.updated = null;
    f.state.exists = false;
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.order.paid'), f.deps), /owner disappeared/);
    assert.deepEqual(f.exists.mock.calls[0].arguments, [{ _id: ownerId }]);
    assert.equal(f.getCache.mock.callCount(), 0);
});

test('unknown or absent plan products do not downgrade an existing Pro owner', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.owner.plan_tier = 'pro';
    for (const productId of ['unknown-product', undefined]) {
        for (const type of ['billing.order.paid', 'billing.subscription.updated']) {
            await applyPolarPlanDomainEvent(event(type, { productId }), f.deps);
        }
    }
    f.assertNoEffects();
    assert.equal(f.state.owner.plan_tier, 'pro');
});

test('credits request a guarded Mongo snapshot for an internal owner without Twitch, without cache', async t => {
    const f = fixture(t);
    const input = event('billing.customer.state.changed');
    await applyPolarCreditsDomainEvent(input, f.deps);
    assert.equal(f.update.mock.callCount(), 1);
    assert.deepEqual(f.update.mock.calls[0].arguments, [{
        _id: ownerId,
        $or: [
            { 'polar_credit_snapshot.occurredAt': { $exists: false } },
            { 'polar_credit_snapshot.occurredAt': { $lt: occurredAt } },
            { 'polar_credit_snapshot.occurredAt': occurredAt, 'polar_credit_snapshot.eventKey': { $lte: input.eventKey } },
        ],
    }, { $set: { polar_credit_snapshot: { occurredAt, eventKey: input.eventKey, meters } } }, { new: true }]);
    assert.deepEqual(f.updateSelect.mock.calls[0].arguments, ['+polar_credit_snapshot']);
    assert.equal(f.findById.mock.callCount(), 0);
    assert.equal(f.getCache.mock.callCount(), 0);
});

test('credits send state, both exhaustion flags, and version to one eval per owner Twitch account', async t => {
    const f = fixture(t, ['twitch-owner-1', 'twitch-owner-2']);
    await applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps);
    assert.deepEqual(f.getCache.mock.calls[0].arguments, ['PolarCreditsProjection']);
    assert.equal(f.getCache.mock.callCount(), 1);
    assert.equal(f.fakeRedis.eval.mock.callCount(), 2);
    for (const [index, id] of ['twitch-owner-1', 'twitch-owner-2'].entries()) {
        const [script, options] = f.fakeRedis.eval.mock.calls[index].arguments;
        assert.deepEqual(options.keys, [
            `twitch:${id}:ai:credits`, `twitch:${id}:ai:exhaust`, `${id}:ai:exhaust`, `twitch:${id}:ai:credits:polar-version`,
        ]);
        assert.deepEqual(options.arguments, [
            `${occurredAt.getTime()}:polar-webhook:delivery-1`,
            JSON.stringify({ version: 2, used: 30, limit: 25000, balance: 24970,
                meterId: AI_CREDITS_METER_ID, updatedAt: occurredAt.toISOString(), available: true }),
            '0', String(AI_CREDITS_CACHE_TTL_SECONDS),
        ]);
        // Inspect the submitted script contract only; fakeRedis never executes Lua.
        assert.match(script, /previous > ARGV\[1\].*return 0/);
        for (const key of [1, 2, 3, 4]) assert.ok(script.includes(`redis.call('SET', KEYS[${key}]`));
        assert.match(script, /redis.call\('DEL', KEYS\[2\], KEYS\[3\]\)/);
    }
    assert.equal(f.fakeRedis.del.mock.callCount(), 0);
});

for (const newer of ['timestamp', 'same-time event key']) {
    test(`stale credits project the latest DB snapshot (${newer}), plan, and accounts instead of event or owner data`, async t => {
        const f = fixture(t, ['outdated-twitch-owner']);
        const currentAt = newer === 'timestamp' ? new Date('2026-09-04T11:00:00Z') : occurredAt;
        f.state.updated = null;
        f.state.latest = {
            ...f.state.owner, plan_tier: 'pro',
            accounts: [{ type: 'twitch', id: 'current-twitch-owner' }] as IUsers['accounts'],
            polar_credit_snapshot: {
                occurredAt: currentAt, eventKey: 'polar-webhook:delivery-9',
                meters: [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 500000, balance: -500000 }],
            },
        };
        await applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps);
        assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId]);
        assert.deepEqual(f.findSelect.mock.calls[0].arguments, ['+polar_credit_snapshot']);
        assert.equal(f.fakeRedis.eval.mock.callCount(), 1);
        const [, options] = f.fakeRedis.eval.mock.calls[0].arguments;
        assert.deepEqual(options.keys, [
            'twitch:current-twitch-owner:ai:credits', 'twitch:current-twitch-owner:ai:exhaust',
            'current-twitch-owner:ai:exhaust', 'twitch:current-twitch-owner:ai:credits:polar-version',
        ]);
        assert.equal(options.arguments[0], `${currentAt.getTime()}:polar-webhook:delivery-9`);
        assert.deepEqual(JSON.parse(options.arguments[1]), {
            version: 2, used: 500000, limit: 500000, balance: 0,
            meterId: AI_CREDITS_METER_ID, updatedAt: currentAt.toISOString(), available: true,
        });
        assert.equal(options.arguments[2], '1');
    });
}

for (const [balance, exhaustion] of [[-2, '1'], [0, '1'], [12, '0'], [undefined, '']] as const) {
    test(`legacy-only meter balance ${balance} supplies exhaustion ${exhaustion} without inventing current credits`, async t => {
        const f = fixture(t, ['twitch-owner']);
        const legacyMeters = [{ meter_id: legacyMeterId, balance }];
        f.state.updated!.polar_credit_snapshot!.meters = legacyMeters;
        await applyPolarCreditsDomainEvent(event('billing.customer.state.changed', { meters: legacyMeters }), f.deps);
        assert.equal(f.fakeRedis.eval.mock.callCount(), 1);
        assert.deepEqual(f.fakeRedis.eval.mock.calls[0].arguments[1].arguments.slice(1), [
            '', exhaustion, String(AI_CREDITS_CACHE_TTL_SECONDS),
        ]);
    });
}

for (const [used, legacyBalance, exhaustion] of [[30, -100, '0'], [25000, 100, '1']] as const) {
    test(`current meter wins over conflicting legacy balance ${legacyBalance}`, async t => {
        const f = fixture(t, ['twitch-owner']);
        const currentMeters = [
            { meter_id: legacyMeterId, balance: legacyBalance },
            { meter_id: AI_CREDITS_METER_ID, consumed_units: used, balance: -used },
        ];
        f.state.updated!.polar_credit_snapshot!.meters = currentMeters;
        await applyPolarCreditsDomainEvent(event('billing.customer.state.changed', { meters: currentMeters }), f.deps);
        const [, options] = f.fakeRedis.eval.mock.calls[0].arguments;
        assert.equal(options.arguments[2], exhaustion);
        assert.equal(JSON.parse(options.arguments[1]).balance, 25000 - used);
    });
}

test('empty credit meters submit a version but no invented credits or exhaustion decision', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.updated!.polar_credit_snapshot!.meters = [];
    await applyPolarCreditsDomainEvent(event('billing.customer.state.changed', { meters: [] }), f.deps);
    assert.deepEqual(f.fakeRedis.eval.mock.calls[0].arguments[1].arguments.slice(1), ['', '', String(AI_CREDITS_CACHE_TTL_SECONDS)]);
});

test('missing meters reject before ownership or persistence effects', async t => {
    const f = fixture(t);
    await assert.rejects(applyPolarCreditsDomainEvent(event('billing.customer.state.changed', { meters: undefined }), f.deps), /missing meters/);
    f.assertNoEffects();
});

for (const missing of ['owner', 'snapshot']) {
    test(`credits reject when the fallback DB read lacks the ${missing}`, async t => {
        const f = fixture(t, ['twitch-owner']);
        f.state.updated = null;
        f.state.latest = missing === 'owner' ? null : f.state.owner;
        await assert.rejects(applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps), /snapshot could not be persisted/);
        assert.equal(f.findById.mock.callCount(), 1);
        assert.equal(f.getCache.mock.callCount(), 0);
    });
}

for (const [name, handler, type] of [
    ['plan', applyPolarPlanDomainEvent, 'billing.order.paid'],
    ['credits', applyPolarCreditsDomainEvent, 'billing.customer.state.changed'],
] as const) {
    for (const failure of ['getCache', 'command']) {
        test(`${name} ${failure} error rejects for retry after the Mongo projection attempt`, async t => {
            const f = fixture(t, ['twitch-owner']);
            const error = new Error('cache unavailable');
            const fail = async () => { throw error; };
            if (failure === 'getCache') f.getCache.mock.mockImplementation(fail);
            else if (name === 'plan') f.fakeRedis.del.mock.mockImplementation(fail);
            else f.fakeRedis.eval.mock.mockImplementation(fail);
            await assert.rejects(handler(event(type), f.deps), err => err === error);
            assert.equal(f.update.mock.callCount(), 1);
            assert.equal(f.getCache.mock.callCount(), 1);
        });
    }
}

for (const productId of [PRODUCT_IDS.PREMIUM, PRODUCT_IDS.PRO]) {
    for (const cadence of ['monthly', 'yearly'] as const) {
        test(`paid ${productId} ${cadence} reward uses resolved canonical owner and order, not provider or subscription ID`, async t => {
            const f = fixture(t);
            const input = event('billing.order.paid', { productId, cadence, status: 'partially_refunded' });
            input.ownerUserId = 'abcdef0123456789abcdef01';
            await applyPolarRewardDomainEvent(input, f.deps);
            assert.deepEqual(f.getOwner.mock.calls[0].arguments, [input]);
            assert.deepEqual(f.applyReward.mock.calls.map(call => call.arguments), [[{
                ownerUserId: ownerId.toString(), orderId: 'order-1', productId, cadence,
            }]]);
            assert.equal(f.update.mock.callCount(), 0);
            assert.equal(f.getCache.mock.callCount(), 0);
        });
    }
}

test('subscription status updates and other provider events never trigger rewards even with paid=true', async t => {
    const f = fixture(t);
    for (const type of ['billing.subscription.updated', 'billing.customer.state.changed', 'provider.polar.order.updated', 'provider.polar.order.refunded']) {
        for (const status of ['active', 'paid', 'canceled', 'past_due', 'unpaid', 'revoked']) {
            await applyPolarRewardDomainEvent(event(type, { status }), f.deps);
        }
    }
    f.assertNoEffects();
});

for (const [payload, message] of [
    [{ paid: false }, /confirmed paid order/],
    [{ paid: undefined }, /confirmed paid order/],
    [{ orderId: undefined }, /confirmed paid order/],
    [{ orderId: '' }, /confirmed paid order/],
    [{ cadence: undefined }, /billing cadence/],
] as const) {
    const label = Object.entries(payload).map(([key, value]) => `${key}=${String(value)}`).join(', ');
    test(`invalid reward payload ${label} rejects without effects`, async t => {
        const f = fixture(t);
        await assert.rejects(applyPolarRewardDomainEvent(event('billing.order.paid', payload), f.deps), message);
        f.assertNoEffects();
    });
}

test('free, unknown, and absent reward products have no effects', async t => {
    const f = fixture(t);
    for (const productId of [PRODUCT_IDS.FREE, 'unknown-product', undefined]) {
        await applyPolarRewardDomainEvent(event('billing.order.paid', { productId }), f.deps);
    }
    f.assertNoEffects();
});

test('reward application errors propagate unchanged for retry', async t => {
    const f = fixture(t);
    const error = new Error('reward unavailable');
    f.applyReward.mock.mockImplementation(async () => { throw error; });
    await assert.rejects(applyPolarRewardDomainEvent(event('billing.order.paid'), f.deps), err => err === error);
    assert.equal(f.applyReward.mock.callCount(), 1);
});

for (const [name, handler, type] of [
    ['plan', applyPolarPlanDomainEvent, 'billing.order.paid'],
    ['credits', applyPolarCreditsDomainEvent, 'billing.customer.state.changed'],
    ['reward', applyPolarRewardDomainEvent, 'billing.order.paid'],
] as const) {
    test(`${name} propagates getOwner failures without downstream effects`, async t => {
        const f = fixture(t);
        const error = new Error('owner resolution unavailable');
        f.getOwner.mock.mockImplementation(async () => { throw error; });
        await assert.rejects(handler(event(type), f.deps), err => err === error);
        assert.equal(f.getOwner.mock.callCount(), 1);
        assert.equal(f.update.mock.callCount(), 0);
        assert.equal(f.getCache.mock.callCount(), 0);
        assert.equal(f.applyReward.mock.callCount(), 0);
    });

    test(`${name} default owner lookup rejects a missing canonical user with mocked Mongoose`, async t => {
        const f = fixture(t);
        f.state.latest = null;
        const { getOwner: _getOwner, ...deps } = f.deps;
        await assert.rejects(handler(event(type), deps), /no longer exists/);
        assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId.toString()]);
        assert.equal(f.update.mock.callCount(), 0);
        assert.equal(f.getCache.mock.callCount(), 0);
        assert.equal(f.applyReward.mock.callCount(), 0);
    });

    test(`${name} source filter excludes Twitch even when its event type matches billing`, async t => {
        const f = fixture(t);
        for (const source of ['twitch-eventsub', 'twitch-chat']) {
            await handler({ ...event(type), source, channelID: 'twitch-owner' }, f.deps);
        }
        f.assertNoEffects();
    });

    test(`${name} ignores unrelated Polar event types`, async t => {
        const f = fixture(t);
        await handler(event('provider.polar.product.updated'), f.deps);
        f.assertNoEffects();
    });
}
