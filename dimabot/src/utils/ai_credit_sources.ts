import { AI_CREDITS_METER_ID } from './billing.js';
import { getCreditPackDefinition } from './credit_packs.js';
import { GIFT_PACK_PAIRS, giftPolarRequest } from './credit_gift_provider.js';

export interface CreditSourceEvent {
    id?: unknown;
    name?: unknown;
    timestamp?: unknown;
    metadata?: unknown;
}

interface CreditGrant {
    id: string;
    customer_id: string;
    benefit_id: string;
    order_id: string | null;
    subscription_id: string | null;
    benefit: { id: string; type: string; properties: { meter_id?: string; units?: number; rollover?: boolean } };
}
interface CreditOrder {
    id: string;
    customer_id: string;
    product_id: string;
    subscription_id: string | null;
    paid: boolean;
    total_amount: number;
    metadata?: Record<string, unknown>;
}
export interface CreditSourceReads {
    grant(id: string): Promise<CreditGrant | null>;
    order(id: string): Promise<CreditOrder>;
}

function polarCreditSourceReads(customerId: string): CreditSourceReads {
    let grants: Promise<Map<string, CreditGrant>> | null = null;
    async function listGrants(): Promise<Map<string, CreditGrant>> {
        const result = new Map<string, CreditGrant>();
        for (let page = 1; page <= 100; page++) {
            const query = new URLSearchParams({ customer_id: customerId, limit: '100', page: String(page), sorting: '-created_at' });
            const response = await giftPolarRequest<{ items: CreditGrant[]; pagination?: { max_page?: number } }>(`/v1/benefit-grants/?${query}`);
            for (const grant of response.items) result.set(grant.id, grant);
            const maxPage = response.pagination?.max_page;
            if (typeof maxPage === 'number' ? page >= maxPage : response.items.length < 100) return result;
        }
        throw new Error('Credit source grant history is too large');
    }
    return {
        // Polar exposes List Benefit Grants, with no Get-by-ID operation.
        // Load the customer's complete grant list once per reporting sync.
        grant: async id => { grants ??= listGrants(); return (await grants).get(id) ?? null; },
        order: id => giftPolarRequest(`/v1/orders/${encodeURIComponent(id)}`),
    };
}

// Polar's public credit events have no grant/order ID. Its benefit event follows
// the meter credit. Correlate only a unique pair within this short interval,
// verified against the customer's grant, meter and order. Never infer purpose
// from rollover, plan, amount alone, or an order's proximity to a credit.
export const CREDIT_SOURCE_MATCH_MS = 5_000;
const metadata = (event: CreditSourceEvent): Record<string, unknown> =>
    event.metadata && typeof event.metadata === 'object' ? event.metadata as Record<string, unknown> : {};
const text = (value: unknown): string | null =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
const at = (event: CreditSourceEvent): number => event.timestamp instanceof Date
    ? event.timestamp.getTime() : new Date(String(event.timestamp || '')).getTime();

/** Reporting only; these reads never create grants or ingest balance changes. */
export async function classifyPolarCreditSources(customerId: string, events: CreditSourceEvent[], reads: CreditSourceReads = polarCreditSourceReads(customerId)): Promise<Map<string, string>> {
    const credits = events.filter(event => {
        const m = metadata(event);
        return event.name === 'meter.credited' && text(event.id)
            && (m.meterId ?? m.meter_id) === AI_CREDITS_METER_ID
            && typeof m.units === 'number' && Number.isFinite(m.units) && m.units > 0
            && typeof m.rollover === 'boolean' && Number.isFinite(at(event));
    });
    const benefits = events.filter(event => {
        const m = metadata(event);
        return ['benefit.granted', 'benefit.cycled'].includes(String(event.name))
            && (m.benefitType ?? m.benefit_type) === 'meter_credit'
            && text(m.benefitGrantId ?? m.benefit_grant_id) && Number.isFinite(at(event));
    });
    const grants = new Map<string, CreditGrant>();
    const orders = new Map<string, CreditOrder>();
    const matches: { credit: CreditSourceEvent; benefit: CreditSourceEvent; grant: CreditGrant }[] = [];
    for (const benefit of benefits) {
        const nearby = credits.filter(credit => at(benefit) >= at(credit) && at(benefit) - at(credit) <= CREDIT_SOURCE_MATCH_MS);
        if (!nearby.length) continue;
        const m = metadata(benefit);
        const id = text(m.benefitGrantId ?? m.benefit_grant_id)!;
        let grant = grants.get(id);
        if (!grant) {
            const found = await reads.grant(id);
            if (!found) continue;
            grant = found; grants.set(id, grant);
        }
        if (grant.id !== id || grant.customer_id !== customerId
            || grant.benefit_id !== (m.benefitId ?? m.benefit_id) || grant.benefit.id !== grant.benefit_id
            || grant.benefit.type !== 'meter_credit' || grant.benefit.properties.meter_id !== AI_CREDITS_METER_ID) continue;
        for (const credit of nearby) {
            const cm = metadata(credit);
            // Subscription amounts can change after a historical cycle. One-time
            // purchases/gifts must match their grant's exact credited quantity.
            if (cm.rollover !== grant.benefit.properties.rollover
                || (!grant.subscription_id && cm.units !== grant.benefit.properties.units)) continue;
            matches.push({ credit, benefit, grant });
        }
    }
    const result = new Map<string, string>();
    for (const { credit, benefit, grant } of matches) {
        if (matches.filter(match => match.credit === credit).length !== 1
            || matches.filter(match => match.benefit === benefit).length !== 1) continue;
        if (grant.subscription_id && !grant.order_id) {
            result.set(String(credit.id), 'subscription_credits');
        } else if (grant.order_id && !grant.subscription_id) {
            let order = orders.get(grant.order_id);
            if (!order) { order = await reads.order(grant.order_id); orders.set(grant.order_id, order); }
            if (order.id !== grant.order_id || order.customer_id !== customerId || !order.paid || order.subscription_id) continue;
            if (order.metadata?.source === 'dimabot_gift_fulfillment' && text(order.metadata.gift_id)
                && GIFT_PACK_PAIRS.some(pair => pair.fulfillmentProductId === order!.product_id) && order.total_amount === 0) {
                result.set(String(credit.id), 'gifted_credits');
            } else if (getCreditPackDefinition(order.product_id) && order.metadata?.source !== 'dimabot_gift_fulfillment') {
                result.set(String(credit.id), 'purchased_pack');
            }
        }
    }
    return result;
}
