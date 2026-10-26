import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import type { Polar } from '@polar-sh/sdk';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { AI_CREDITS_CACHE_SCHEMA_VERSION, AI_CREDITS_CACHE_TTL_SECONDS, AI_CREDITS_METER_ID, creditPackBillingContextCacheKey } from '../utils/billing.js';
import { PRODUCT_IDS } from '../utils/referral.js';
import { DomainEventPrerequisiteMissingError, type DomainEventEnvelope } from './domain_event.types.js';
import { polarWebhookProducer } from './polar_events.js';
import type { PolarBillingPayload } from './polar_events.js';
import { POLAR_PLAN_EVENT_TYPES, POLAR_ENTITLEMENT_REQUEST_OPTIONS, loadPolarGraceSubscriptions, resolvePolarEntitledPlan, polarEntitlementFingerprint, type PolarEntitlementState } from './polar_entitlements.js';
import { parsePolarPlanReconciliationArgs } from '../scripts/reconcile_polar_plan.script.js';
import {
    applyPolarPlanDomainEvent,
    applyPolarCreditsDomainEvent,
    applyPolarRewardDomainEvent,
    reconcilePolarPlanEntitlement,
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
            totalAmount: 600, cadence: 'monthly', status: 'paid', periodEnd: '2026-10-04T10:00:00Z', meters,
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
        polarState: { id: 'polar-customer', activeSubscriptions: [{ id: 'subscription-1', productId: PRODUCT_IDS.PREMIUM,
            status: 'active', currentPeriodEnd: new Date('2026-10-04T10:00:00Z') }], grantedBenefits: [] } as PolarEntitlementState,
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
    const acknowledgeEffects = t.mock.method(UsersSchema, 'updateOne', (async () => ({ matchedCount: 1, modifiedCount: 1 })) as unknown as typeof UsersSchema.updateOne);
    const fakeRedis = {
        eval: t.mock.fn(async (_script: string, _options: { keys: string[]; arguments: string[] }) => 1),
        del: t.mock.fn(async (_keys: string[]) => 1),
    };
    const getOwner = t.mock.fn(async (_event: DomainEventEnvelope) => state.owner);
    const getCache = t.mock.fn(async (_caller?: string) => fakeRedis);
    const applyReward = t.mock.fn(async (_input: Parameters<NonNullable<Dependencies['applyReward']>>[0]) => {});
    const adjustUsageRetention = t.mock.fn(async (_channelIDs: string[], _planTier: string) => {});
    const getCustomerState = t.mock.fn(async (_customerId: string) => state.polarState);
    const getGraceSubscriptions = t.mock.fn<NonNullable<Dependencies['getGraceSubscriptions']>>(async () => []);
    const deps: Dependencies = {
        getOwner, getCache: getCache as unknown as Dependencies['getCache'], applyReward,
        adjustUsageRetention: adjustUsageRetention as Dependencies['adjustUsageRetention'],
        getCustomerState, getGraceSubscriptions, now: () => occurredAt,
    };
    function assertNoEffects() {
        for (const mock of [getOwner, getCache, applyReward, adjustUsageRetention, getCustomerState, getGraceSubscriptions, update, acknowledgeEffects, findById, exists, fakeRedis.eval, fakeRedis.del]) {
            assert.equal(mock.mock.callCount(), 0);
        }
    }
    return { state, deps, getOwner, getCache, getCustomerState, getGraceSubscriptions, applyReward, adjustUsageRetention, fakeRedis, update, acknowledgeEffects, updateSelect, findById, findSelect, exists, assertNoEffects };
}

test('regression: past_due Premium product with no Polar entitlements must project Free', async t => {
    const f = fixture(t);
    await applyPolarPlanDomainEvent(event('billing.subscription.updated', { status: 'past_due' }), {
        ...f.deps,
        getCustomerState: async () => ({ id: 'polar-customer', activeSubscriptions: [], grantedBenefits: [] }),
    });
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'free');
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, null);
});

test('regression: retained benefit revocation reconciles access rather than remaining unmapped', async t => {
    const f = fixture(t);
    const input = event('provider.polar.benefit_grant.revoked');
    input.payload = { providerData: { id: 'grant-1', customerId: 'polar-customer' } };
    await applyPolarPlanDomainEvent(input, {
        ...f.deps,
        getCustomerState: async () => ({ id: 'polar-customer', activeSubscriptions: [], grantedBenefits: [] }),
    });
    assert.equal(f.update.mock.callCount(), 1);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'free');
});

test('regression: stale customer state cannot restore Premium when fresh state grants nothing', async t => {
    const f = fixture(t);
    await applyPolarPlanDomainEvent(event('billing.customer.state.changed'), {
        ...f.deps,
        getCustomerState: async () => ({ id: 'polar-customer', activeSubscriptions: [], grantedBenefits: [] }),
    });
    assert.equal(f.update.mock.callCount(), 1);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'free');
});

for (const type of POLAR_PLAN_EVENT_TYPES) {
    test(`plan lifecycle ${type} reads fresh customer authority, ignoring the event's stale status`, async t => {
        const f = fixture(t);
        const input = event(type, { status: 'past_due', productId: PRODUCT_IDS.PRO });
        input.occurredAt = new Date('2025-01-01T00:00:00Z');
        await applyPolarPlanDomainEvent(input, f.deps);
        assert.deepEqual(f.getCustomerState.mock.calls[0].arguments, ['polar-customer']);
        assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'premium');
        assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.polar_plan_event_at, occurredAt);
        assert.equal(f.applyReward.mock.callCount(), 0);
    });
}

test('multiple subscriptions choose highest active tier, and cancellation of another subscription cannot downgrade it', async t => {
    const f = fixture(t);
    f.state.polarState.activeSubscriptions.push({ id: 'pro-sub', productId: PRODUCT_IDS.PRO, status: 'active',
        currentPeriodEnd: new Date('2026-12-01T00:00:00Z'), endsAt: null });
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'pro');
    assert.deepEqual(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, new Date('2026-12-01T00:00:00Z'));
});

test('trial entitlement uses trial end; scheduled cancellation retains current paid access', async t => {
    const f = fixture(t);
    const subscription = f.state.polarState.activeSubscriptions[0];
    subscription.status = 'trialing';
    subscription.trialEnd = new Date('2026-09-10T00:00:00Z');
    await applyPolarPlanDomainEvent(event('billing.order.paid', { totalAmount: 0 }), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'premium');
    assert.deepEqual(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, subscription.trialEnd);
    subscription.status = 'active';
    subscription.endsAt = subscription.currentPeriodEnd;
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.canceled'), f.deps);
    assert.equal(f.update.mock.calls[1].arguments[1]?.$set?.plan_tier, 'premium');
    assert.deepEqual(f.update.mock.calls[1].arguments[1]?.$set?.plan_tier_until, subscription.endsAt);
});

test('past_due grace requires a still-granted subscription-linked benefit; recovery reads active subscription', async t => {
    const f = fixture(t);
    f.state.polarState.activeSubscriptions = [];
    f.state.polarState.grantedBenefits = [{ id: 'live-grant', benefitId: 'benefit-1' }];
    f.getGraceSubscriptions.mock.mockImplementation(async () => [{ id: 'premium-sub', customerId: 'polar-customer',
        status: 'past_due', productId: PRODUCT_IDS.PREMIUM, currentPeriodEnd: new Date('2026-11-10T00:00:00Z') }]);
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.past_due'), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'premium');
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, null);
    f.state.polarState.grantedBenefits = [];
    await applyPolarPlanDomainEvent(event('provider.polar.benefit_grant.revoked'), f.deps);
    assert.equal(f.update.mock.calls[1].arguments[1]?.$set?.plan_tier, 'free');
    f.state.polarState.activeSubscriptions = [{ id: 'premium-sub', productId: PRODUCT_IDS.PREMIUM, status: 'active',
        currentPeriodEnd: new Date('2026-11-10T00:00:00Z') }];
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.active'), f.deps);
    assert.equal(f.update.mock.calls[2].arguments[1]?.$set?.plan_tier, 'premium');
});

for (const lookup of ['getCustomerState', 'getGraceSubscriptions'] as const) {
    test(`${lookup} failure propagates for delivery retry before plan writes`, async t => {
        const f = fixture(t);
        f.state.polarState.grantedBenefits = [{ id: 'grant', benefitId: 'benefit' }];
        const error = new Error('Polar API unavailable');
        f[lookup].mock.mockImplementation(async () => { throw error; });
        await assert.rejects(applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps), e => e === error);
        assert.equal(f.update.mock.callCount(), 0);
        assert.equal(f.getCache.mock.callCount(), 0);
    });
}

test('fresh state or linked-owner identity mismatch rejects without writing a plan', async t => {
    const f = fixture(t);
    f.state.polarState.id = 'other-customer';
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps), /another customer/);
    f.state.owner.polar_sh_customer_id = 'other-customer';
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps), /pinned owner/);
    assert.equal(f.update.mock.callCount(), 0);
});

test('unrelated benefit revocation preserves a separate active Pro subscription', async t => {
    const f = fixture(t);
    f.state.polarState.activeSubscriptions[0].productId = PRODUCT_IDS.PRO;
    await applyPolarPlanDomainEvent(event('provider.polar.benefit_grant.revoked'), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'pro');
    assert.equal(f.getGraceSubscriptions.mock.callCount(), 0);
});

test('same-tier subscriptions use longest access; expired/incomplete/unpaid products cannot grant', async () => {
    const state: PolarEntitlementState = { id: 'customer', grantedBenefits: [], activeSubscriptions: [
        { id: 'expired', productId: PRODUCT_IDS.PRO, status: 'active', currentPeriodEnd: new Date('2020-01-01') },
        { id: 'unpaid', productId: PRODUCT_IDS.PRO, status: 'unpaid' },
        { id: 'incomplete', productId: PRODUCT_IDS.PRO, status: 'incomplete' },
        { id: 'past-due', productId: PRODUCT_IDS.PRO, status: 'past_due' },
        { id: 'canceled', productId: PRODUCT_IDS.PRO, status: 'canceled' },
        { id: 'short', productId: PRODUCT_IDS.PREMIUM, status: 'active', currentPeriodEnd: new Date('2026-10-01') },
        { id: 'long', productId: PRODUCT_IDS.PREMIUM, status: 'active', currentPeriodEnd: new Date('2026-11-01') },
    ] };
    assert.deepEqual(await resolvePolarEntitledPlan(state, 'customer', occurredAt, async () => []),
        { planTier: 'premium', until: new Date('2026-11-01') });
});

test('older in-flight Polar lookup cannot overwrite the later lookup that revoked access', async t => {
    const f = fixture(t);
    let release!: (value: PolarEntitlementState) => void;
    const pending = new Promise<PolarEntitlementState>(resolve => { release = resolve; });
    let version = new Date(0);
    let projected = 'free';
    f.update.mock.mockImplementation(((filter: { $or: Array<{ polar_plan_event_at?: { $lt?: Date } }> }, update: { $set: { plan_tier: string; polar_plan_event_at: Date } }) => ({
        lean: async () => {
            const requested = filter.$or[1].polar_plan_event_at?.$lt!;
            if (requested < version) return null;
            version = update.$set.polar_plan_event_at;
            projected = update.$set.plan_tier;
            return f.state.owner;
        }
    })) as unknown as typeof UsersSchema.findOneAndUpdate);
    const older = applyPolarPlanDomainEvent(event('billing.subscription.updated'), { ...f.deps,
        now: () => occurredAt, getCustomerState: async () => pending });
    const later = new Date(occurredAt.getTime() + 1000);
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), { ...f.deps,
        now: () => later, getCustomerState: async () => ({ id: 'polar-customer', activeSubscriptions: [], grantedBenefits: [] }) });
    release(f.state.polarState);
    await assert.rejects(older, /retry fresh state/);
    assert.equal(projected, 'free');
    assert.equal(version, later);
});

test('grace lookup follows only live matching grants to actual subscriptions, never one-time/shared benefit guesses', async t => {
    const live = { id: 'live', benefitId: 'shared-benefit', customerId: 'polar-customer', isGranted: true, isRevoked: false, subscriptionId: 'grace-sub' };
    const grants = [live,
        { ...live, id: 'gift', subscriptionId: null },
        { ...live, id: 'revoked', isRevoked: true },
        { ...live, id: 'other-customer', customerId: 'elsewhere' },
        { ...live, id: 'not-granted', isGranted: false },
        { ...live, id: 'wrong-benefit', benefitId: 'different' },
        { ...live, id: 'unlisted' }];
    const list = t.mock.fn(async (request: { customerId: string; page: number }, _options: unknown) => ({
        result: { items: request.page === 1 ? grants.slice(0, 2) : grants.slice(2), pagination: { maxPage: 2 } }
    }));
    const get = t.mock.fn(async (_input: { id: string }, _options: unknown) => ({ id: 'grace-sub', customerId: 'polar-customer',
        productId: PRODUCT_IDS.PREMIUM, status: 'past_due' }));
    const client = { benefitGrants: { list }, subscriptions: { get } } as unknown as Polar;
    const result = await loadPolarGraceSubscriptions(client, 'polar-customer',
        grants.filter(g => g.id !== 'unlisted').map(g => ({ id: g.id, benefitId: 'shared-benefit' })));
    assert.equal(result.length, 1);
    assert.deepEqual(get.mock.calls.map(call => call.arguments), [[{ id: 'grace-sub' }, POLAR_ENTITLEMENT_REQUEST_OPTIONS]]);
    assert.deepEqual(list.mock.calls[0].arguments, [{ customerId: 'polar-customer', isGranted: true, page: 1, limit: 100 }, POLAR_ENTITLEMENT_REQUEST_OPTIONS]);
});

test('grace lookup fails rather than silently truncating customer grant pagination', async t => {
    const list = t.mock.fn(async () => ({ result: { items: [], pagination: { maxPage: 6 } } }));
    await assert.rejects(loadPolarGraceSubscriptions({ benefitGrants: { list } } as unknown as Polar,
        'polar-customer', [{ id: 'grant', benefitId: 'benefit' }]), /bounded scope/);
    assert.equal(list.mock.callCount(), 5);
});

test('grace lookup API failure rejects unchanged instead of falling back to the event product', async () => {
    const error = new Error('Polar unavailable');
    await assert.rejects(loadPolarGraceSubscriptions({ benefitGrants: { list: async () => { throw error; } } } as unknown as Polar,
        'polar-customer', [{ id: 'grant', benefitId: 'benefit' }]), e => e === error);
});

test('reconciliation defaults to scoped dry-run, and execute reuses projection/cache/retention without rewards or credits', async t => {
    const f = fixture(t, ['twitch-owner']);
    const input = { ownerUserId: ownerId.toString(), customerId: 'polar-customer' };
    const result = await reconcilePolarPlanEntitlement(input, f.deps);
    assert.equal(result.executed, false);
    assert.equal(result.applied, false);
    assert.equal(result.proposed.planTier, 'premium');
    assert.equal(f.update.mock.callCount(), 0);
    assert.equal(f.getCache.mock.callCount(), 0);
    const executed = await reconcilePolarPlanEntitlement({ ...input, execute: true }, f.deps);
    assert.equal(executed.applied, true);
    assert.equal(f.update.mock.callCount(), 1);
    assert.equal(f.fakeRedis.del.mock.callCount(), 0);
    assert.equal(f.adjustUsageRetention.mock.callCount(), 1);
    assert.equal(f.applyReward.mock.callCount(), 0);
    assert.equal(f.fakeRedis.eval.mock.callCount(), 1);
});

test('reconciliation rejects mismatched explicit IDs before Polar lookup or updates', async t => {
    const f = fixture(t);
    await assert.rejects(reconcilePolarPlanEntitlement({ ownerUserId: '', customerId: '' }, f.deps), /explicit/);
    f.assertNoEffects();
    await assert.rejects(reconcilePolarPlanEntitlement({ ownerUserId: ownerId.toString(), customerId: 'wrong-customer', execute: true }, f.deps), /link mismatch/);
    assert.equal(f.getCustomerState.mock.callCount(), 0);
    assert.equal(f.update.mock.callCount(), 0);
});

test('reconciliation CLI requires exact IDs and has an explicit execute flag', () => {
    assert.deepEqual(parsePolarPlanReconciliationArgs(['--owner', ownerId.toString(), '--customer', 'polar-customer']),
        { ownerUserId: ownerId.toString(), customerId: 'polar-customer', execute: false });
    assert.equal(parsePolarPlanReconciliationArgs(['--owner', ownerId.toString(), '--customer', 'polar-customer', '--execute']).execute, true);
    for (const args of [[], ['--execute'], ['--owner', ownerId.toString()], ['--all'],
        ['--owner', ownerId.toString(), '--customer', '--execute']]) assert.throws(() => parsePolarPlanReconciliationArgs(args));
});

test('unchanged managed entitlement avoids retention rewrites and cache flushing on meter snapshots', async t => {
    const f = fixture(t, ['twitch-owner']);
    Object.assign(f.state.owner, { plan_tier: 'premium', plan_tier_until: new Date('2026-10-04T10:00:00Z'), polar_plan_event_key: 'prior' });
    await applyPolarPlanDomainEvent(event('billing.customer.state.changed'), f.deps);
    assert.equal(f.update.mock.callCount(), 1, 'watermark still advances');
    assert.equal(f.adjustUsageRetention.mock.callCount(), 0);
    assert.equal(f.getCache.mock.callCount(), 0);
    assert.equal(f.acknowledgeEffects.mock.callCount(), 0);
});

function entitlementSnapshot(state: PolarEntitlementState): Partial<PolarBillingPayload> {
    const json = JSON.parse(JSON.stringify(state)) as PolarBillingPayload;
    return { activeSubscriptions: json.activeSubscriptions, grantedBenefits: json.grantedBenefits };
}

test('identical normalized entitlement contents skip Polar reads before GET, including active Premium grants', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.polarState.activeSubscriptions[0].trialStart = new Date('2026-08-01T00:00:00Z');
    f.state.polarState.activeSubscriptions[0].trialEnd = new Date('2026-08-10T00:00:00Z');
    f.state.polarState.grantedBenefits = [{ id: 'g2', benefitId: 'b2' }, { id: 'g1', benefitId: 'b1' }];
    Object.assign(f.state.owner, { plan_tier: 'premium', plan_tier_until: new Date('2026-10-04T10:00:00Z'),
        polar_plan_event_key: 'managed', polar_plan_entitlement_fingerprint: polarEntitlementFingerprint(f.state.polarState) });
    const payload = entitlementSnapshot(f.state.polarState);
    payload.grantedBenefits!.reverse();
    await applyPolarPlanDomainEvent(event('billing.customer.state.changed', payload), f.deps);
    assert.equal(f.getCustomerState.mock.callCount(), 0);
    assert.equal(f.getGraceSubscriptions.mock.callCount(), 0);
    assert.equal(f.update.mock.callCount(), 0);
    assert.equal(f.getCache.mock.callCount(), 0);
});

for (const reason of ['pending', 'expired', 'legacy', 'lifecycle'] as const) {
    test(`${reason} state cannot use the entitlement fingerprint fast path`, async t => {
        const f = fixture(t);
        Object.assign(f.state.owner, { plan_tier: 'premium', plan_tier_until: new Date('2026-10-04T10:00:00Z'),
            polar_plan_event_key: 'managed', polar_plan_entitlement_fingerprint: polarEntitlementFingerprint(f.state.polarState) });
        if (reason === 'pending') f.state.owner.polar_plan_effects_pending = true;
        if (reason === 'expired') f.state.owner.plan_tier_until = new Date(occurredAt.getTime() - 1);
        await applyPolarPlanDomainEvent(event(reason === 'lifecycle' ? 'billing.subscription.updated' : 'billing.customer.state.changed',
            reason === 'legacy' ? {} : entitlementSnapshot(f.state.polarState)), f.deps);
        assert.equal(f.getCustomerState.mock.callCount(), 1);
        assert.equal(f.update.mock.callCount(), 1);
    });
}

test('changed grant fingerprint still resolves a higher Pro grace entitlement over active Premium', async t => {
    const f = fixture(t);
    Object.assign(f.state.owner, { plan_tier: 'premium', plan_tier_until: null, polar_plan_event_key: 'managed',
        polar_plan_entitlement_fingerprint: polarEntitlementFingerprint(f.state.polarState) });
    f.state.polarState.grantedBenefits = [{ id: 'pro-grant', benefitId: 'benefit' }];
    f.getGraceSubscriptions.mock.mockImplementation(async () => [{ id: 'pro-sub', customerId: 'polar-customer', productId: PRODUCT_IDS.PRO, status: 'past_due' }]);
    await applyPolarPlanDomainEvent(event('billing.customer.state.changed', entitlementSnapshot(f.state.polarState)), f.deps);
    assert.equal(f.getGraceSubscriptions.mock.callCount(), 1);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'pro');
});

test('failed plan CAS can complete when the current tier/expiry already match with no unfinished effects', async t => {
    const f = fixture(t);
    f.state.updated = null;
    f.state.latest = { ...f.state.owner, plan_tier: 'premium', plan_tier_until: new Date('2026-10-04T10:00:00Z') };
    await applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps);
    assert.equal(f.getCache.mock.callCount(), 0);
    assert.equal(f.adjustUsageRetention.mock.callCount(), 0);
});

for (const failure of ['retention', 'cache'] as const) {
    test(`pending plan effects survive a ${failure} failure after Mongo changes the tier`, async t => {
        const f = fixture(t, ['twitch-owner']);
        f.update.mock.mockImplementation(((_filter: unknown, update: { $set: Record<string, unknown> }) => ({
            lean: async () => { Object.assign(f.state.owner, update.$set); return { ...f.state.owner }; }
        })) as unknown as typeof UsersSchema.findOneAndUpdate);
        f.acknowledgeEffects.mock.mockImplementation((async () => {
            delete f.state.owner.polar_plan_effects_pending;
            return { matchedCount: 1, modifiedCount: 1 };
        }) as unknown as typeof UsersSchema.updateOne);
        const fail = new Error('effect failed');
        let failOnce = true;
        if (failure === 'retention') f.adjustUsageRetention.mock.mockImplementation(async () => {
            if (failOnce) { failOnce = false; throw fail; }
        });
        else f.fakeRedis.eval.mock.mockImplementation(async () => {
            if (failOnce) { failOnce = false; throw fail; }
            return 1;
        });
        await assert.rejects(applyPolarPlanDomainEvent(event('billing.customer.state.changed'), f.deps), e => e === fail);
        assert.equal(f.state.owner.plan_tier, 'premium');
        assert.equal(f.state.owner.polar_plan_effects_pending, true);
        await applyPolarPlanDomainEvent(event('billing.customer.state.changed'), f.deps);
        assert.equal(f.state.owner.polar_plan_effects_pending, undefined);
        assert.equal(f.adjustUsageRetention.mock.callCount(), 2);
        const effects = f.fakeRedis.eval.mock.callCount();
        await applyPolarPlanDomainEvent(event('billing.customer.state.changed'), f.deps);
        assert.equal(f.adjustUsageRetention.mock.callCount(), 2, 'completed effects do not run again on identical meter snapshots');
        assert.equal(f.fakeRedis.eval.mock.callCount(), effects);
    });
}

test('downgrade invalidates cached tier allowance and credit-pack context, preserving Polar credit/ledger/exhaustion state', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.owner.plan_tier = 'premium';
    f.state.owner.polar_plan_event_key = 'managed-plan';
    f.state.polarState.activeSubscriptions = [];
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), f.deps);
    assert.deepEqual(f.fakeRedis.eval.mock.calls[0].arguments[1], {
        keys: ['twitch:twitch-owner:ai:credits:plan-version', 'twitch:twitch-owner:ai:credits',
            'accounts:twitch:twitch-owner:data', 'twitch:accounts', creditPackBillingContextCacheKey('polar-customer')],
        arguments: [`${occurredAt.getTime()}:polar-webhook:delivery-1`]
    });
    assert.equal(f.fakeRedis.del.mock.callCount(), 0);
    assert.deepEqual(f.adjustUsageRetention.mock.calls[0].arguments, [['twitch-owner'], 'free']);
    assert.deepEqual(f.acknowledgeEffects.mock.calls[0].arguments, [{ _id: ownerId, polar_plan_event_key: 'polar-webhook:delivery-1' },
        { $unset: { polar_plan_effects_pending: '' } }]);
});

test('regression: old Premium credits resumed after downgrade cannot restore paid allowance or alter meter/exhaustion receipts', async t => {
    const f = fixture(t, ['twitch-owner']);
    const priorAt = new Date(occurredAt.getTime() - 1000);
    Object.assign(f.state.owner, { plan_tier: 'premium', polar_plan_event_at: priorAt, polar_plan_event_key: 'older-plan' });
    f.state.updated = { ...f.state.updated!, ...f.state.owner };
    // Service-free Redis model: apply the supplied version arguments/keys and
    // pause the real credits consumer after its Mongo read, before cache access.
    // Exact Lua execution is also required in the lead's isolated candidate check.
    const values = new Map<string, string>([
        ['twitch:twitch-owner:ai:exhaust', 'true'], ['twitch-owner:ai:exhaust', 'true'],
        ['twitch:twitch-owner:ai:credits:polar-version', `${priorAt.getTime()}:retained-meter-version`]
    ]);
    f.fakeRedis.del.mock.mockImplementation(async keys => { keys.forEach(key => values.delete(key)); return keys.length; });
    f.fakeRedis.eval.mock.mockImplementation(async (script, options) => {
        const { keys, arguments: args } = options;
        if (script.includes("redis.call('GET', KEYS[4])")) {
            const planVersion = values.get(keys[4]);
            if (planVersion && planVersion > args[4]) return 0;
            const previous = values.get(keys[3]);
            if (previous && previous > args[0]) return 0;
            values.set(keys[3], args[0]);
            if (args[1]) values.set(keys[0], args[1]);
            if (args[2] === '1') { values.set(keys[1], 'true'); values.set(keys[2], 'true'); }
            else if (args[2] === '0') { values.delete(keys[1]); values.delete(keys[2]); }
            return 1;
        }
        const previous = values.get(keys[0]);
        if (previous && previous > args[0]) return 0;
        values.set(keys[0], args[0]);
        keys.slice(1).forEach(key => values.delete(key));
        return 1;
    });
    // No fence yet: existing snapshots can continue publishing the legacy cache.
    await applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps);
    assert.ok(JSON.parse(values.get('twitch:twitch-owner:ai:credits')!).limit > 25000);
    assert.equal(values.has('twitch:twitch-owner:ai:credits:plan-version'), false);
    values.set('twitch:twitch-owner:ai:credits:polar-version', `${priorAt.getTime()}:retained-meter-version`);
    values.set('twitch:twitch-owner:ai:exhaust', 'true');
    values.set('twitch-owner:ai:exhaust', 'true');
    let cacheRead!: () => void;
    let resumeCredits!: () => void;
    const paused = new Promise<void>(resolve => { cacheRead = resolve; });
    const resume = new Promise<void>(resolve => { resumeCredits = resolve; });
    f.getCache.mock.mockImplementation(async caller => {
        if (caller === 'PolarCreditsProjection') { cacheRead(); await resume; }
        return f.fakeRedis;
    });
    const oldCreditWrite = applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps);
    await paused;
    f.state.polarState.activeSubscriptions = [];
    f.state.updated = { ...f.state.owner, plan_tier: 'free', polar_plan_event_at: occurredAt,
        polar_plan_event_key: 'polar-webhook:delivery-1', polar_credit_snapshot: { occurredAt, eventKey: 'polar-webhook:delivery-1', meters } };
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), f.deps);
    resumeCredits();
    await oldCreditWrite;
    assert.equal(values.has('twitch:twitch-owner:ai:credits'), false);
    assert.equal(values.get('twitch:twitch-owner:ai:credits:polar-version'), `${priorAt.getTime()}:retained-meter-version`);
    assert.equal(values.get('twitch:twitch-owner:ai:exhaust'), 'true');
    assert.equal(values.get('twitch-owner:ai:exhaust'), 'true');
    const creditCall = f.fakeRedis.eval.mock.calls.filter(call => call.arguments[0].includes("redis.call('GET', KEYS[4])"))[1];
    assert.match(creditCall.arguments[0], /currentPlanVersion > ARGV\[5\].*return 0/);
    assert.ok(creditCall.arguments[0].indexOf('currentPlanVersion >') < creditCall.arguments[0].indexOf("redis.call('SET'"));
    assert.equal(creditCall.arguments[1].arguments[4], `${priorAt.getTime()}:older-plan`);

    // The newly read Free plan can still publish current meter state normally.
    f.state.updated.polar_credit_snapshot!.eventKey = 'zz-current-meter';
    await applyPolarCreditsDomainEvent(event('billing.customer.state.changed'), f.deps);
    const credits = JSON.parse(values.get('twitch:twitch-owner:ai:credits')!);
    assert.equal(credits.limit, 25000);
    assert.equal(values.get('twitch:twitch-owner:ai:credits:plan-version'), `${occurredAt.getTime()}:polar-webhook:delivery-1`);
    const currentCache = new Map(values);
    f.state.latest = { ...f.state.updated };
    f.state.updated = null; // A delayed plan request loses the Mongo version guard.
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), { ...f.deps, now: () => priorAt });
    assert.deepEqual(values, currentCache, 'old invalidation cannot roll back the plan fence or delete newer credits');
    const planScript = f.fakeRedis.eval.mock.calls.find(call => !call.arguments[0].includes("redis.call('GET', KEYS[4])"))!.arguments[0];
    assert.match(planScript, /previous > ARGV\[1\].*return 0/);
    assert.doesNotMatch(planScript, /'EX'|'PX'/, 'the plan fence is persistent');
});

test('meter-only empty entitlements preserve markerless paid tiers while lifecycle revocation still applies', async t => {
    const f = fixture(t);
    f.state.owner.plan_tier = 'premium';
    f.state.polarState.activeSubscriptions = [];
    await applyPolarPlanDomainEvent(event('billing.customer.state.changed'), f.deps);
    assert.equal(f.update.mock.callCount(), 0);
    assert.equal(f.getCache.mock.callCount(), 0);
    await applyPolarPlanDomainEvent(event('provider.polar.subscription.revoked'), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier, 'free');
    assert.equal(f.update.mock.callCount(), 1);
});

for (const type of ['billing.order.paid', 'billing.subscription.updated']) {
    for (const [productId, planTier] of [
        [PRODUCT_IDS.FREE, 'free'], [PRODUCT_IDS.PREMIUM, 'premium'], [PRODUCT_IDS.PRO, 'pro'],
    ] as const) {
        test(`${type} projects authoritative ${planTier} for an internal owner using lookup-time/key guards`, async t => {
            const f = fixture(t);
            f.state.polarState.activeSubscriptions[0].productId = productId;
            const input = event(type, { productId });
            await applyPolarPlanDomainEvent(input, f.deps);
            assert.deepEqual(f.getOwner.mock.calls[0].arguments, [input]);
            assert.equal(f.update.mock.callCount(), 1);
            assert.deepEqual(f.update.mock.calls[0].arguments, [{
                _id: ownerId,
                polar_sh_customer_id: 'polar-customer',
                $or: [
                    { polar_plan_event_at: { $exists: false } },
                    { polar_plan_event_at: { $lt: occurredAt } },
                    { polar_plan_event_at: occurredAt, polar_plan_event_key: { $lte: input.eventKey } },
                ],
            }, { $set: {
                plan_tier: planTier, plan_tier_until: planTier === 'free' ? null : new Date('2026-10-04T10:00:00Z'),
                polar_plan_event_at: occurredAt, polar_plan_event_key: input.eventKey,
                polar_plan_entitlement_fingerprint: polarEntitlementFingerprint(f.state.polarState),
                ...(planTier === 'free' ? {} : { polar_plan_effects_pending: true }),
            } }, { new: true }]);
            assert.equal(f.exists.mock.callCount(), 0);
            assert.equal(f.getCache.mock.callCount(), planTier === 'free' ? 0 : 1);
            assert.equal(f.applyReward.mock.callCount(), 0);
        });
    }
}

test('plan without a period end clears expiry and invalidates only owner Twitch caches', async t => {
    const f = fixture(t, ['twitch-owner-1', 'twitch-owner-2']);
    f.state.polarState.activeSubscriptions[0].currentPeriodEnd = null;
    await applyPolarPlanDomainEvent(event('billing.order.paid', { periodEnd: null }), f.deps);
    assert.equal(f.update.mock.calls[0].arguments[1]?.$set?.plan_tier_until, null);
    assert.deepEqual(f.getCache.mock.calls[0].arguments, ['PolarPlanProjection']);
    assert.deepEqual(f.fakeRedis.eval.mock.calls.map(call => call.arguments[1]), ['twitch-owner-1', 'twitch-owner-2'].map(id => ({
        keys: [`twitch:${id}:ai:credits:plan-version`, `twitch:${id}:ai:credits`, `accounts:twitch:${id}:data`,
            'twitch:accounts', creditPackBillingContextCacheKey('polar-customer')],
        arguments: [`${occurredAt.getTime()}:polar-webhook:delivery-1`]
    })));
    assert.equal(f.fakeRedis.del.mock.callCount(), 0);
    assert.deepEqual(f.adjustUsageRetention.mock.calls[0].arguments, [['twitch-owner-1', 'twitch-owner-2'], 'premium']);
});

test('failed plan CAS with divergent current entitlement retries without effects', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.updated = null;
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps), /retry fresh state/);
    assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId]);
    assert.equal(f.update.mock.callCount(), 1);
    assert.equal(f.fakeRedis.eval.mock.callCount(), 0);
    assert.equal(f.adjustUsageRetention.mock.callCount(), 0);
});

test('owner disappearing during plan update rejects before cache work', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.updated = null;
    f.state.latest = null;
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.order.paid'), f.deps), /owner disappeared/);
    assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId]);
    assert.equal(f.getCache.mock.callCount(), 0);
});

test('plan update pins the customer link observed before provider lookup and rejects a changed link', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.getCustomerState.mock.mockImplementation(async () => {
        // The owner still exists, but the exact original link no longer matches.
        f.state.updated = null;
        f.state.latest = { ...f.state.owner, polar_sh_customer_id: 'changed-customer' };
        return f.state.polarState;
    });
    await assert.rejects(applyPolarPlanDomainEvent(event('billing.subscription.updated'), f.deps), /customer link changed/);
    assert.equal((f.update.mock.calls[0].arguments[0] as { polar_sh_customer_id?: string }).polar_sh_customer_id, 'polar-customer');
    assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId]);
    assert.equal(f.getCache.mock.callCount(), 0);
    assert.equal(f.adjustUsageRetention.mock.callCount(), 0);
});

test('unknown or absent one-time order products do not alter an existing Pro owner', async t => {
    const f = fixture(t, ['twitch-owner']);
    f.state.owner.plan_tier = 'pro';
    for (const productId of ['unknown-product', undefined]) {
        await applyPolarPlanDomainEvent(event('billing.order.paid', { productId }), f.deps);
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
            `twitch:${id}:ai:credits:plan-version`,
        ]);
        assert.deepEqual(options.arguments, [
            `${occurredAt.getTime()}:polar-webhook:delivery-1`,
            JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION, used: 30, limit: 25000, balance: 24970,
                meterId: AI_CREDITS_METER_ID, updatedAt: occurredAt.toISOString(), available: true, status: 'available' }),
            '0', String(AI_CREDITS_CACHE_TTL_SECONDS), '',
        ]);
        // Inspect the submitted script contract only; fakeRedis never executes Lua.
        assert.match(script, /previous > ARGV\[1\].*return 0/);
        assert.match(script, /currentPlanVersion and currentPlanVersion > ARGV\[5\].*return 0/);
        for (const key of [1, 2, 3, 4]) assert.ok(script.includes(`redis.call('SET', KEYS[${key}]`));
        assert.doesNotMatch(script, /SET', KEYS\[2\].*'EX'/);
        assert.doesNotMatch(script, /SET', KEYS\[3\].*'EX'/);
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
                meters: [{ meter_id: AI_CREDITS_METER_ID, consumed_units: 800000, balance: -800000 }],
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
            'twitch:current-twitch-owner:ai:credits:plan-version',
        ]);
        assert.equal(options.arguments[0], `${currentAt.getTime()}:polar-webhook:delivery-9`);
        assert.deepEqual(JSON.parse(options.arguments[1]), {
            version: AI_CREDITS_CACHE_SCHEMA_VERSION, used: 800000, limit: 800000, balance: 0,
            meterId: AI_CREDITS_METER_ID, updatedAt: currentAt.toISOString(), available: true, status: 'exhausted',
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
            '', exhaustion, String(AI_CREDITS_CACHE_TTL_SECONDS), '',
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
    assert.deepEqual(f.fakeRedis.eval.mock.calls[0].arguments[1].arguments.slice(1), ['', '', String(AI_CREDITS_CACHE_TTL_SECONDS), '']);
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

test('zero-dollar trials and one-time orders do not earn referral rewards', async t => {
    const f = fixture(t);
    for (const payload of [
        { totalAmount: 0 },
        { totalAmount: undefined },
        { subscriptionId: undefined },
        { subscriptionId: undefined, totalAmount: 600 },
    ]) {
        await applyPolarRewardDomainEvent(event('billing.order.paid', payload), f.deps);
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
        await assert.rejects(handler(event(type), deps), error => error instanceof DomainEventPrerequisiteMissingError
            && error.prerequisite === 'owner:Polar owner no longer exists');
        assert.deepEqual(f.findById.mock.calls[0].arguments, [ownerId.toString()]);
        assert.equal(f.update.mock.callCount(), 0);
        assert.equal(f.getCache.mock.callCount(), 0);
        assert.equal(f.applyReward.mock.callCount(), 0);
    });

    test(`${name} unresolved owner mapping is a repairable prerequisite, without mutating persisted ownership`, async t => {
        const f = fixture(t);
        const input = event(type);
        delete input.ownerUserId;
        assert.ok(polarWebhookProducer.resolveOwner);
        t.mock.method(polarWebhookProducer as Required<typeof polarWebhookProducer>, 'resolveOwner', async () => undefined);
        const { getOwner: _getOwner, ...deps } = f.deps;
        await assert.rejects(handler(input, deps), error => error instanceof DomainEventPrerequisiteMissingError
            && error.prerequisite.startsWith('owner:'));
        assert.equal(input.ownerUserId, undefined);
        f.assertNoEffects();
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
