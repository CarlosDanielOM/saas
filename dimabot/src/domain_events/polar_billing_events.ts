import { DomainEventPrerequisiteMissingError, type DomainEventEnvelope } from './domain_event.types.js';
import type { PolarBillingPayload } from './polar_events.js';
import { polarWebhookProducer } from './polar_events.js';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { PRODUCT_IDS } from '../utils/referral.js';
import { applyPaidOrderReward } from '../utils/paid_order_reward.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { AI_CREDITS_METER_ID, AI_CREDITS_CACHE_TTL_SECONDS, buildAiCreditsDataFromMeter, creditPackBillingContextCacheKey } from '../utils/billing.js';
import { adjustAiUsageRetention } from '../utils/ai_usage_ledger.js';
import { getPolarShClient } from '../utils/polarsh.js';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { PLAN_CACHE_VERSION_FIELD, planCacheVersion } from '../utils/plan_cache_fence.js';
import { POLAR_PLAN_EVENT_TYPES, POLAR_ENTITLEMENT_REQUEST_OPTIONS, loadPolarGraceSubscriptions, resolvePolarEntitledPlan, polarEntitlementFingerprint,
    type PolarEntitlementState, type PolarGraceLookup, type PolarPlan } from './polar_entitlements.js';

const LEGACY_USAGE_METER_ID = '01d90c16-87d0-4e31-880a-4045a8da90cd';
const INVALIDATE_PLAN_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
`;
const SYNC_CREDITS_SCRIPT = `
local currentPlanVersion = redis.call('GET', KEYS[5])
if currentPlanVersion and currentPlanVersion > ARGV[5] then return 0 end
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[4], ARGV[1])
if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4]) end
if ARGV[3] == '1' then
    redis.call('SET', KEYS[2], 'true')
    redis.call('SET', KEYS[3], 'true')
elseif ARGV[3] == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
`;

interface PolarBillingDependencies {
    getOwner(event: DomainEventEnvelope): Promise<IUsers>;
    getCache: typeof getDragonflyClient;
    applyReward: typeof applyPaidOrderReward;
    adjustUsageRetention: typeof adjustAiUsageRetention;
    getCustomerState(customerId: string): Promise<PolarEntitlementState>;
    getGraceSubscriptions: PolarGraceLookup;
    now(): Date;
}

const dependencies: PolarBillingDependencies = {
    async getOwner(event) {
        const ownerUserId = event.ownerUserId || await polarWebhookProducer.resolveOwner?.(event);
        if (!ownerUserId) throw new DomainEventPrerequisiteMissingError('owner:polar customer mapping unresolved');
        const user = await UsersSchema.findById(ownerUserId).lean();
        if (!user) throw new DomainEventPrerequisiteMissingError('owner:Polar owner no longer exists');
        return user;
    },
    getCache: getDragonflyClient,
    applyReward: applyPaidOrderReward,
    adjustUsageRetention: adjustAiUsageRetention,
    async getCustomerState(customerId) {
        const client = await getPolarShClient('PolarPlanProjection');
        return client.customers.getState({ id: customerId }, POLAR_ENTITLEMENT_REQUEST_OPTIONS);
    },
    async getGraceSubscriptions(customerId, grants) {
        return loadPolarGraceSubscriptions(await getPolarShClient('PolarPlanProjection'), customerId, grants);
    },
    now: () => new Date()
};

export async function applyPolarPlanDomainEvent(
    event: DomainEventEnvelope,
    injected: Partial<PolarBillingDependencies> = {}
): Promise<void> {
    if (event.source !== 'polar-webhook'
        || !POLAR_PLAN_EVENT_TYPES.includes(event.type)) return;
    const payload = event.payload as PolarBillingPayload;
    // One-time credit/gift orders are not subscription entitlement signals.
    if (event.type === 'billing.order.paid' && !Object.values(PRODUCT_IDS).some(id => id === payload.productId)) return;
    const deps = { ...dependencies, ...injected };
    const owner = await deps.getOwner(event);
    const customerId = payload.customerId ?? (event.subject?.kind === 'customer' ? event.subject.id : undefined);
    if (!customerId || (owner.polar_sh_customer_id && owner.polar_sh_customer_id !== customerId)) {
        throw new Error('Polar plan customer does not match its pinned owner');
    }
    // Version by lookup start, not delivery time: even an old webhook reads current
    // authority, and an older in-flight request cannot overwrite a later lookup.
    const observedAt = deps.now();
    if (event.type === 'billing.customer.state.changed' && Array.isArray(payload.activeSubscriptions)
        && Array.isArray(payload.grantedBenefits) && !owner.polar_plan_effects_pending
        && (!owner.plan_tier_until || owner.plan_tier_until > observedAt)
        && owner.polar_plan_entitlement_fingerprint === polarEntitlementFingerprint({
            activeSubscriptions: payload.activeSubscriptions, grantedBenefits: payload.grantedBenefits })) return;
    const state = await deps.getCustomerState(customerId);
    const { planTier, until } = await resolvePolarEntitledPlan(
        state, customerId, observedAt, deps.getGraceSubscriptions);
    // A meter-only snapshot does not establish that a legacy/manual paid tier was
    // Polar-managed. Actual subscription lifecycle events still reconcile/revoke it.
    if (event.type === 'billing.customer.state.changed' && owner.plan_tier !== 'free'
        && !owner.polar_plan_event_key && planTier === 'free') return;
    await projectPolarPlan(owner, { planTier, until }, observedAt, event.eventKey, customerId, deps, polarEntitlementFingerprint(state));
}

async function projectPolarPlan(
    owner: IUsers, { planTier, until }: PolarPlan, observedAt: Date, eventKey: string, customerId: string, deps: PolarBillingDependencies,
    fingerprint: string
): Promise<boolean> {
    const needsEffects = owner.polar_plan_effects_pending === true || owner.plan_tier !== planTier
        || (owner.plan_tier_until?.getTime() ?? null) !== (until?.getTime() ?? null);
    const updated = await UsersSchema.findOneAndUpdate({
        _id: owner._id,
        polar_sh_customer_id: owner.polar_sh_customer_id || null,
        $or: [
            { polar_plan_event_at: { $exists: false } },
            { polar_plan_event_at: { $lt: observedAt } },
            { polar_plan_event_at: observedAt, polar_plan_event_key: { $lte: eventKey } }
        ]
    }, { $set: {
        plan_tier: planTier,
        plan_tier_until: until,
        polar_plan_event_at: observedAt,
        polar_plan_event_key: eventKey,
        polar_plan_entitlement_fingerprint: fingerprint,
        ...(needsEffects ? { polar_plan_effects_pending: true } : {})
    } }, { new: true }).lean();
    if (!updated) {
        const current = await UsersSchema.findById(owner._id).lean();
        if (!current || (current.polar_sh_customer_id || null) !== (owner.polar_sh_customer_id || null)) {
            throw new DomainEventPrerequisiteMissingError('owner:Polar owner disappeared or customer link changed before plan update');
        }
        if (current.plan_tier !== planTier || (current.plan_tier_until?.getTime() ?? null) !== (until?.getTime() ?? null)
            || current.polar_plan_effects_pending) {
            throw new Error('Polar plan projection lost ordering race to divergent or unfinished entitlement; retry fresh state');
        }
        return false;
    }
    // Keep the pending bit until retention and every cache invalidation succeeds.
    // Retries after the plan write must not infer success from an unchanged tier.
    if (!needsEffects && !updated?.polar_plan_effects_pending) return Boolean(updated);
    const twitchAccounts = owner.accounts.filter((account) => account.type === 'twitch');
    if (updated && twitchAccounts.length > 0) {
        await deps.adjustUsageRetention(twitchAccounts.map((account) => account.id), planTier);
    }
    const cache = await deps.getCache('PolarPlanProjection');
    if (!twitchAccounts.length) await cache.del(creditPackBillingContextCacheKey(customerId));
    for (const account of twitchAccounts) {
        // Publish a persistent monotonic fence atomically with invalidation. A
        // credits consumer that already read the old paid plan cannot refill it.
        await cache.eval(INVALIDATE_PLAN_SCRIPT, {
            keys: [`twitch:${account.id}:ai:credits:plan-version`, `twitch:${account.id}:ai:credits`,
                `accounts:twitch:${account.id}:data`, 'twitch:accounts', creditPackBillingContextCacheKey(customerId)],
            arguments: [planCacheVersion(observedAt, eventKey)]
        });
    }
    if (updated) {
        await UsersSchema.updateOne({ _id: owner._id, polar_plan_event_key: eventKey },
            { $unset: { polar_plan_effects_pending: '' } });
    }
    return Boolean(updated);
}

/** Targeted operator repair. No scans, journal replay, credits or rewards. Dry-run by default. */
export async function reconcilePolarPlanEntitlement(
    input: { ownerUserId: string; customerId: string; execute?: boolean },
    injected: Partial<PolarBillingDependencies> = {}
): Promise<{ ownerUserId: string; customerId: string; executed: boolean; applied: boolean; before: PolarPlan; proposed: PolarPlan }> {
    if (!/^[a-f\d]{24}$/i.test(input.ownerUserId) || !input.customerId?.trim()) {
        throw new Error('Reconciliation requires explicit ownerUserId and customerId');
    }
    const deps = { ...dependencies, ...injected };
    const observedAt = deps.now();
    const receipt = `plan-reconciliation:${randomUUID()}`;
    const event: DomainEventEnvelope = {
        _id: new Types.ObjectId(), eventKey: receipt, sourceEventId: receipt, source: 'polar-webhook',
        type: 'billing.customer.state.changed', topic: 'domain', schemaVersion: 1,
        ownerUserId: input.ownerUserId, subject: { provider: 'polar', kind: 'customer', id: input.customerId },
        occurredAt: observedAt, journaledAt: observedAt, expiresAt: new Date(observedAt.getTime() + 86_400_000),
        payload: { customerId: input.customerId, meters: [] }, metadata: { originalEventType: 'customer.state_changed' }
    };
    const owner = await deps.getOwner(event);
    // Unlike webhook ownership resolution, a manual repair requires an existing exact link.
    if (owner._id.toString() !== input.ownerUserId || owner.polar_sh_customer_id !== input.customerId) {
        throw new Error('Reconciliation owner/customer link mismatch');
    }
    const state = await deps.getCustomerState(input.customerId);
    const proposed = await resolvePolarEntitledPlan(state, input.customerId, observedAt, deps.getGraceSubscriptions);
    const applied = input.execute === true ? await projectPolarPlan(owner, proposed, observedAt, receipt, input.customerId, deps,
        polarEntitlementFingerprint(state)) : false;
    return { ownerUserId: input.ownerUserId, customerId: input.customerId, executed: input.execute === true, applied,
        before: { planTier: owner.plan_tier, until: owner.plan_tier_until ?? null }, proposed };
}

export async function applyPolarCreditsDomainEvent(
    event: DomainEventEnvelope,
    injected: Partial<PolarBillingDependencies> = {}
): Promise<void> {
    if (event.source !== 'polar-webhook' || event.type !== 'billing.customer.state.changed') return;
    const payload = event.payload as PolarBillingPayload;
    if (!Array.isArray(payload.meters)) throw new Error('Polar credit snapshot is missing meters');
    const deps = { ...dependencies, ...injected };
    const owner = await deps.getOwner(event);
    const snapshot = { occurredAt: event.occurredAt, eventKey: event.eventKey, meters: payload.meters };
    const updated = await UsersSchema.findOneAndUpdate({
        _id: owner._id,
        $or: [
            { 'polar_credit_snapshot.occurredAt': { $exists: false } },
            { 'polar_credit_snapshot.occurredAt': { $lt: event.occurredAt } },
            { 'polar_credit_snapshot.occurredAt': event.occurredAt, 'polar_credit_snapshot.eventKey': { $lte: event.eventKey } }
        ]
    }, { $set: { polar_credit_snapshot: snapshot } }, { new: true }).select('+polar_credit_snapshot').lean()
        || await UsersSchema.findById(owner._id).select('+polar_credit_snapshot').lean();
    if (!updated) throw new DomainEventPrerequisiteMissingError('owner:Polar owner credit snapshot could not be persisted');
    if (!updated.polar_credit_snapshot) throw new Error('Polar owner credit snapshot could not be persisted');
    const current = updated.polar_credit_snapshot;
    const creditsMeter = current.meters.find((meter) => meter.meter_id === AI_CREDITS_METER_ID);
    const legacyMeter = current.meters.find((meter) => meter.meter_id === LEGACY_USAGE_METER_ID);
    const credits = creditsMeter ? buildAiCreditsDataFromMeter(creditsMeter, updated.plan_tier, current.occurredAt.toISOString()) : undefined;
    const balance = credits?.balance ?? legacyMeter?.balance;
    const exhaustion = balance === undefined ? '' : balance <= 0 ? '1' : '0';
    const planVersion = planCacheVersion(updated.polar_plan_event_at, updated.polar_plan_event_key);
    const twitchAccounts = updated.accounts.filter((account) => account.type === 'twitch');
    if (twitchAccounts.length === 0) return;
    const cache = await deps.getCache('PolarCreditsProjection');
    for (const account of twitchAccounts) {
        await cache.eval(SYNC_CREDITS_SCRIPT, {
            keys: [
                `twitch:${account.id}:ai:credits`, `twitch:${account.id}:ai:exhaust`,
                `${account.id}:ai:exhaust`, `twitch:${account.id}:ai:credits:polar-version`,
                `twitch:${account.id}:ai:credits:plan-version`
            ],
            arguments: [
                `${String(current.occurredAt.getTime()).padStart(13, '0')}:${current.eventKey}`,
                credits ? JSON.stringify({ ...credits, ...(planVersion ? { [PLAN_CACHE_VERSION_FIELD]: planVersion } : {}) }) : '',
                exhaustion, String(AI_CREDITS_CACHE_TTL_SECONDS), planVersion
            ]
        });
    }
}

export async function applyPolarRewardDomainEvent(
    event: DomainEventEnvelope,
    injected: Partial<PolarBillingDependencies> = {}
): Promise<void> {
    if (event.source !== 'polar-webhook' || event.type !== 'billing.order.paid') return;
    const payload = event.payload as PolarBillingPayload;
    if (payload.paid !== true || !payload.orderId) throw new Error('Polar rewards require a confirmed paid order');
    // Polar also emits order.paid for $0 trial starts. One-time orders have no subscription.
    // Older journal rows without an amount must fail closed on reward replay.
    if (!payload.subscriptionId || !payload.totalAmount || payload.totalAmount <= 0) return;
    if (payload.productId !== PRODUCT_IDS.PREMIUM && payload.productId !== PRODUCT_IDS.PRO) return;
    if (!payload.cadence) throw new Error('Polar paid order is missing its billing cadence');
    const deps = { ...dependencies, ...injected };
    const owner = await deps.getOwner(event);
    await deps.applyReward({
        ownerUserId: owner._id.toString(), orderId: payload.orderId,
        productId: payload.productId, cadence: payload.cadence
    });
}
