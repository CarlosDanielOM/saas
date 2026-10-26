import type { Polar } from '@polar-sh/sdk';
import { PRODUCT_IDS } from '../utils/referral.js';
import { createHash } from 'node:crypto';

// Keep the shipped provider.polar.* shapes so retained lifecycle rows remain replayable.
export const POLAR_PLAN_EVENT_TYPES = [
    'billing.order.paid', 'billing.subscription.updated', 'billing.customer.state.changed',
    ...['created', 'active', 'canceled', 'uncanceled', 'past_due', 'revoked'].map(type => `provider.polar.subscription.${type}`),
    ...['created', 'updated', 'cycled', 'revoked'].map(type => `provider.polar.benefit_grant.${type}`),
];

export interface PolarEntitlementSubscription {
    id: string;
    productId: string;
    status: string;
    currentPeriodEnd?: Date | null;
    endsAt?: Date | null;
    trialEnd?: Date | null;
    trialStart?: Date | null;
}

export interface PolarEntitlementState {
    id: string;
    activeSubscriptions: PolarEntitlementSubscription[];
    grantedBenefits: Array<{ id: string; benefitId: string }>;
}

export type PolarGraceSubscription = PolarEntitlementSubscription & { customerId: string };
export type PolarGraceLookup = (customerId: string, grants: PolarEntitlementState['grantedBenefits']) => Promise<PolarGraceSubscription[]>;
export interface PolarPlan { planTier: 'free' | 'premium' | 'pro'; until: Date | null }

/** Compare minimal entitlement contents across SDK Dates and normalized v1 JSON. */
export function polarEntitlementFingerprint(state: {
    activeSubscriptions: Array<{ id: string; productId: string; status: string;
        currentPeriodEnd?: Date | string | null; endsAt?: Date | string | null;
        trialStart?: Date | string | null; trialEnd?: Date | string | null }>;
    grantedBenefits: Array<{ id: string; benefitId: string }>;
}): string {
    const subscriptions = state.activeSubscriptions.map(subscription => [subscription.id, subscription.productId, subscription.status,
        ...[subscription.currentPeriodEnd, subscription.endsAt, subscription.trialStart, subscription.trialEnd]
            .map(value => value == null ? null : new Date(value).toISOString())]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const grants = state.grantedBenefits.map(grant => [grant.id, grant.benefitId])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return createHash('sha256').update(JSON.stringify([subscriptions, grants])).digest('hex');
}

function tier(productId: string): PolarPlan['planTier'] {
    return productId === PRODUCT_IDS.PRO ? 'pro' : productId === PRODUCT_IDS.PREMIUM ? 'premium' : 'free';
}
const rank = { free: 0, premium: 1, pro: 2 };
// Durable delivery owns retries. Keep provider calls bounded within its watchdog.
export const POLAR_ENTITLEMENT_REQUEST_OPTIONS = { timeoutMs: 10_000, retries: { strategy: 'none' as const } };

function expiry(subscription: PolarEntitlementSubscription): Date | null {
    const dates = [subscription.currentPeriodEnd, subscription.endsAt,
        ...(subscription.status === 'trialing' ? [subscription.trialEnd] : [])].filter(value => value != null);
    if (dates.some(value => !(value instanceof Date) || !Number.isFinite(value.getTime()))) {
        throw new Error('Polar entitlement has an invalid expiry');
    }
    return dates.length ? new Date(Math.min(...dates.map(value => value.getTime()))) : null;
}

/** State membership, never the triggering webhook's product/status, grants access. */
export async function resolvePolarEntitledPlan(
    state: PolarEntitlementState, customerId: string, now: Date, getGraceSubscriptions: PolarGraceLookup
): Promise<PolarPlan> {
    if (state.id !== customerId || !Array.isArray(state.activeSubscriptions) || !Array.isArray(state.grantedBenefits)) {
        throw new Error('Polar entitlement state is missing or belongs to another customer');
    }
    let plan: PolarPlan = { planTier: 'free', until: null };
    function include(subscription: PolarEntitlementSubscription, grace = false) {
        if (!subscription.id || !subscription.productId || !subscription.status) throw new Error('Malformed Polar entitlement subscription');
        const planTier = tier(subscription.productId);
        if (planTier === 'free') return;
        // During past_due the renewed period is not paid access. Only an actual live
        // subscription-linked grant proves Polar grace; its deadline is owned by Polar.
        const until = grace ? null : expiry(subscription);
        if (until && until <= now) return;
        if (rank[planTier] > rank[plan.planTier]) plan = { planTier, until };
        else if (planTier === plan.planTier && (!until || (plan.until && until > plan.until))) plan.until = until;
    }
    for (const subscription of state.activeSubscriptions) {
        if (subscription.status === 'active' || subscription.status === 'trialing') include(subscription);
    }
    if (state.grantedBenefits.length && plan.planTier !== 'pro') {
        for (const grant of state.grantedBenefits) {
            if (!grant.id || !grant.benefitId) throw new Error('Malformed Polar entitlement grant');
        }
        for (const subscription of await getGraceSubscriptions(customerId, state.grantedBenefits)) {
            if (subscription.customerId !== customerId) throw new Error('Polar grace subscription customer mismatch');
            if (subscription.status === 'past_due') include(subscription, true);
        }
    }
    return plan;
}

/** Resolve grants to their actual subscription, avoiding shared-benefit/product guesses. */
export async function loadPolarGraceSubscriptions(
    client: Polar, customerId: string, grants: PolarEntitlementState['grantedBenefits']
): Promise<PolarGraceSubscription[]> {
    const requested = new Map(grants.map(grant => [grant.id, grant.benefitId]));
    const subscriptionIds = new Set<string>();
    for (let page = 1; page <= 5; page++) {
        const response = await client.benefitGrants.list({ customerId, isGranted: true, page, limit: 100 }, POLAR_ENTITLEMENT_REQUEST_OPTIONS);
        for (const grant of response.result.items) {
            if (requested.get(grant.id) !== grant.benefitId || grant.customerId !== customerId
                || !grant.isGranted || grant.isRevoked || !grant.subscriptionId) continue;
            subscriptionIds.add(grant.subscriptionId);
        }
        if (subscriptionIds.size > 20) throw new Error('Polar entitlement subscription lookup exceeded bounded scope');
        if (page >= response.result.pagination.maxPage) {
            const subscriptions: PolarGraceSubscription[] = [];
            const ids = [...subscriptionIds];
            for (let offset = 0; offset < ids.length; offset += 4) {
                subscriptions.push(...await Promise.all(ids.slice(offset, offset + 4)
                    .map(id => client.subscriptions.get({ id }, POLAR_ENTITLEMENT_REQUEST_OPTIONS))));
            }
            return subscriptions;
        }
    }
    throw new Error('Polar entitlement grant lookup exceeded bounded scope');
}
