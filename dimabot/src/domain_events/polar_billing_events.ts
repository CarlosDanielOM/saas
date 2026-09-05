import type { DomainEventEnvelope } from './domain_event.types.js';
import type { PolarBillingPayload } from './polar_events.js';
import { polarWebhookProducer } from './polar_events.js';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { PRODUCT_IDS } from '../utils/referral.js';
import { applyPaidOrderReward } from '../utils/paid_order_reward.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { AI_CREDITS_METER_ID, AI_CREDITS_CACHE_TTL_SECONDS, buildAiCreditsDataFromMeter } from '../utils/billing.js';

const LEGACY_USAGE_METER_ID = '01d90c16-87d0-4e31-880a-4045a8da90cd';
const SYNC_CREDITS_SCRIPT = `
local previous = redis.call('GET', KEYS[4])
if previous and previous > ARGV[1] then return 0 end
redis.call('SET', KEYS[4], ARGV[1])
if ARGV[2] ~= '' then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4]) end
if ARGV[3] == '1' then
    redis.call('SET', KEYS[2], 'true', 'EX', ARGV[4])
    redis.call('SET', KEYS[3], 'true', 'EX', ARGV[4])
elseif ARGV[3] == '0' then
    redis.call('DEL', KEYS[2], KEYS[3])
end
return 1
`;

interface PolarBillingDependencies {
    getOwner(event: DomainEventEnvelope): Promise<IUsers>;
    getCache: typeof getDragonflyClient;
    applyReward: typeof applyPaidOrderReward;
}

const dependencies: PolarBillingDependencies = {
    async getOwner(event) {
        const ownerUserId = event.ownerUserId || await polarWebhookProducer.resolveOwner?.(event);
        if (!ownerUserId) throw new Error(`Unresolved Polar customer ${event.subject?.id || 'unknown'}`);
        const user = await UsersSchema.findById(ownerUserId).lean();
        if (!user) throw new Error(`Polar owner ${ownerUserId} no longer exists`);
        return user;
    },
    getCache: getDragonflyClient,
    applyReward: applyPaidOrderReward
};

export async function applyPolarPlanDomainEvent(
    event: DomainEventEnvelope,
    injected: Partial<PolarBillingDependencies> = {}
): Promise<void> {
    if (event.source !== 'polar-webhook'
        || !['billing.order.paid', 'billing.subscription.updated'].includes(event.type)) return;
    const payload = event.payload as PolarBillingPayload;
    if (!Object.values(PRODUCT_IDS).some((id) => id === payload.productId)) return;
    const deps = { ...dependencies, ...injected };
    const owner = await deps.getOwner(event);
    const planTier = payload.productId === PRODUCT_IDS.PRO ? 'pro'
        : payload.productId === PRODUCT_IDS.PREMIUM ? 'premium' : 'free';
    const updated = await UsersSchema.findOneAndUpdate({
        _id: owner._id,
        $or: [
            { polar_plan_event_at: { $exists: false } },
            { polar_plan_event_at: { $lt: event.occurredAt } },
            { polar_plan_event_at: event.occurredAt, polar_plan_event_key: { $lte: event.eventKey } }
        ]
    }, { $set: {
        plan_tier: planTier,
        plan_tier_until: payload.periodEnd ? new Date(payload.periodEnd) : null,
        polar_plan_event_at: event.occurredAt,
        polar_plan_event_key: event.eventKey
    } }, { new: true }).lean();
    if (!updated && !await UsersSchema.exists({ _id: owner._id })) {
        throw new Error('Polar owner disappeared before plan update');
    }
    // Invalidate rather than write an event-time snapshot over a newer cached plan.
    const twitchAccounts = owner.accounts.filter((account) => account.type === 'twitch');
    if (twitchAccounts.length > 0) {
        const cache = await deps.getCache('PolarPlanProjection');
        await cache.del(['twitch:accounts', ...twitchAccounts.map((account) => `accounts:twitch:${account.id}:data`)]);
    }
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
    if (!updated?.polar_credit_snapshot) throw new Error('Polar owner credit snapshot could not be persisted');
    const current = updated.polar_credit_snapshot;
    const creditsMeter = current.meters.find((meter) => meter.meter_id === AI_CREDITS_METER_ID);
    const legacyMeter = current.meters.find((meter) => meter.meter_id === LEGACY_USAGE_METER_ID);
    const credits = creditsMeter ? buildAiCreditsDataFromMeter(creditsMeter, updated.plan_tier, current.occurredAt.toISOString()) : undefined;
    const balance = credits?.balance ?? legacyMeter?.balance;
    const exhaustion = balance === undefined ? '' : balance <= 0 ? '1' : '0';
    const twitchAccounts = updated.accounts.filter((account) => account.type === 'twitch');
    if (twitchAccounts.length === 0) return;
    const cache = await deps.getCache('PolarCreditsProjection');
    for (const account of twitchAccounts) {
        await cache.eval(SYNC_CREDITS_SCRIPT, {
            keys: [
                `twitch:${account.id}:ai:credits`, `twitch:${account.id}:ai:exhaust`,
                `${account.id}:ai:exhaust`, `twitch:${account.id}:ai:credits:polar-version`
            ],
            arguments: [
                `${String(current.occurredAt.getTime()).padStart(13, '0')}:${current.eventKey}`,
                credits ? JSON.stringify(credits) : '', exhaustion, String(AI_CREDITS_CACHE_TTL_SECONDS)
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
    if (payload.productId !== PRODUCT_IDS.PREMIUM && payload.productId !== PRODUCT_IDS.PRO) return;
    if (!payload.cadence) throw new Error('Polar paid order is missing its billing cadence');
    const deps = { ...dependencies, ...injected };
    const owner = await deps.getOwner(event);
    await deps.applyReward({
        ownerUserId: owner._id.toString(), orderId: payload.orderId,
        productId: payload.productId, cadence: payload.cadence
    });
}
