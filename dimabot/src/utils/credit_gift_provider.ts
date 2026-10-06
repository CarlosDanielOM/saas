import { AI_CREDITS_METER_ID } from './billing.js';

export const GIFT_PACK_PAIRS = [{
    productId: '6e0c530d-affc-44be-a51b-e11453ef1fa7',
    fulfillmentProductId: 'f14a61f4-a572-4c05-bf4e-1b013d0dc77a',
    credits: 40_000,
}] as const;

export interface GiftOffer {
    id: string;
    name: string;
    credits: number;
    rollover: true;
    priceAmount: number;
    priceCurrency: string;
}

export interface GiftProduct {
    id: string;
    name?: string;
    is_archived?: boolean;
    is_recurring?: boolean;
    visibility?: string;
    prices: Array<{ type?: string; amount_type?: string; price_amount?: number; price_currency?: string; is_archived?: boolean }>;
    benefits: Array<{ id: string; type: string; is_deleted?: boolean; properties?: { units?: number; rollover?: boolean; meter_id?: string } }>;
}

export interface GiftCheckout {
    id: string;
    url: string;
    client_secret: string;
    status: string;
    product_id: string | null;
    customer_id: string | null;
    customer_external_id: string | null;
    amount: number;
    discount_amount: number;
    total_amount: number;
    currency: string;
    metadata: Record<string, unknown>;
}

export interface GiftOrder {
    id: string;
    paid: boolean;
    status: string;
    product_id: string;
    checkout_id: string | null;
    subscription_id: string | null;
    customer_id: string;
    customer: { id: string; external_id?: string | null };
    net_amount: number;
    total_amount: number;
    discount_amount: number;
    refunded_amount: number;
    currency: string;
    metadata: Record<string, unknown>;
}

export interface GiftGrant {
    id: string;
    order_id: string | null;
    customer_id: string;
    benefit_id: string;
    is_granted: boolean;
    is_revoked: boolean;
    granted_at: string | null;
    benefit: { id: string; type: string; properties: { meter_id?: string; units?: number; rollover?: boolean } };
}

export class GiftProviderError extends Error {
    constructor(readonly status: number) { super(`Gift provider request failed (${status})`); }
}

/** Never log provider bodies or paths containing the checkout client secret. */
export async function giftPolarRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = process.env.POLARSH_OAT;
    if (!token) throw new Error('Gift provider is not configured');
    const base = process.env.POLARSH_API_BASE_URL?.replace(/\/$/, '')
        || (process.env.POLARSH_ENVIRONMENT === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh');
    let response: Response;
    try {
        response = await fetch(`${base}${path}`, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
        });
    } catch { throw new Error('Gift provider connection interrupted'); }
    if (!response.ok) throw new GiftProviderError(response.status);
    return await response.json() as T;
}

export function validateGiftPair(paid: GiftProduct, free: GiftProduct) {
    const pair = GIFT_PACK_PAIRS.find(p => p.productId === paid.id && p.fulfillmentProductId === free.id);
    if (!pair || [paid, free].some(p => p.is_archived || p.is_recurring || p.visibility === 'draft')) {
        throw new Error('Gift pack is unavailable');
    }
    const price = (p: GiftProduct) => p.prices.filter(c => c.type === 'one_time' && c.amount_type === 'fixed' && !c.is_archived);
    const purchasePrices = price(paid), deliveryPrices = price(free);
    if (purchasePrices.length !== 1 || deliveryPrices.length !== 1
        || !Number.isSafeInteger(purchasePrices[0]?.price_amount) || (purchasePrices[0]?.price_amount ?? 0) <= 0
        || !purchasePrices[0]?.price_currency || deliveryPrices[0]?.price_amount !== 0
        || deliveryPrices[0]?.price_currency?.toLowerCase() !== purchasePrices[0]?.price_currency?.toLowerCase()
        || paid.benefits.length !== 0 || free.benefits.length !== 1) throw new Error('Gift pack prices or benefits are invalid');
    const benefit = free.benefits[0]!;
    if (!benefit.id || benefit.type !== 'meter_credit' || benefit.is_deleted
        || benefit.properties?.meter_id !== AI_CREDITS_METER_ID || benefit.properties.rollover !== true
        || benefit.properties.units !== pair.credits) throw new Error('Gift pack must grant the configured permanent credits');
    const offer: GiftOffer = {
        id: paid.id, name: 'Sample gift pack', credits: pair.credits, rollover: true,
        priceAmount: purchasePrices[0]!.price_amount!, priceCurrency: purchasePrices[0]!.price_currency!.toLowerCase(),
    };
    return { offer, fulfillmentProductId: free.id, benefitId: benefit.id };
}

export async function loadGiftPair(productId: string) {
    const pair = GIFT_PACK_PAIRS.find(p => p.productId === productId);
    if (!pair) throw new Error('Unknown gift pack');
    const [paid, free] = await Promise.all([
        giftPolarRequest<GiftProduct>(`/v1/products/${pair.productId}`),
        giftPolarRequest<GiftProduct>(`/v1/products/${pair.fulfillmentProductId}`),
    ]);
    return validateGiftPair(paid, free);
}

export async function getGiftPackCatalog(): Promise<{ offers: GiftOffer[] }> {
    return { offers: await Promise.all(GIFT_PACK_PAIRS.map(async p => (await loadGiftPair(p.productId)).offer)) };
}

/** Bounded recovery scan; an ambiguous create NEVER becomes a second create. */
export async function recoverGiftCheckout(giftId: string, productId: string, userId: string): Promise<GiftCheckout | null> {
    const matches: GiftCheckout[] = [];
    for (let page = 1; page <= 5; page++) {
        const query = new URLSearchParams({ product_id: productId, external_customer_id: userId, limit: '100', page: String(page), sorting: '-created_at' });
        const result = await giftPolarRequest<{ items: GiftCheckout[]; pagination: { max_page: number } }>(`/v1/checkouts/?${query}`);
        matches.push(...result.items.filter(c => c.metadata?.gift_id === giftId));
        if (page >= result.pagination.max_page) {
            if (matches.length > 1) throw new Error('Multiple gift checkouts require support');
            return matches[0] ?? null;
        }
    }
    throw new Error('Gift checkout recovery requires support');
}

export async function getGiftCheckoutOrder(checkoutId: string): Promise<GiftOrder | null> {
    const query = new URLSearchParams({ checkout_id: checkoutId, limit: '2' });
    const result = await giftPolarRequest<{ items: GiftOrder[] }>(`/v1/orders/?${query}`);
    if (result.items.length > 1) throw new Error('Multiple gift orders require support');
    return result.items[0] ?? null;
}

export async function getGiftCreditGrant(orderId: string, customerId: string, benefitId: string, credits: number): Promise<GiftGrant | null> {
    for (let page = 1; page <= 5; page++) {
        const query = new URLSearchParams({ customer_id: customerId, limit: '100', page: String(page), sorting: '-created_at' });
        const result = await giftPolarRequest<{ items: GiftGrant[]; pagination: { max_page: number } }>(`/v1/benefit-grants/?${query}`);
        const grant = result.items.find(g => g.order_id === orderId && g.customer_id === customerId && g.benefit_id === benefitId);
        if (grant) {
            if (grant.is_revoked) throw new Error('Gift credit grant was revoked');
            if (!grant.is_granted) return null;
            // Public REST intentionally returns empty internal grant properties. Polar sets is_granted
            // only after the meter strategy creates its system credit event and updates the meter.
            if (!grant.granted_at || !Number.isFinite(Date.parse(grant.granted_at))
                || grant.benefit?.id !== benefitId || grant.benefit.type !== 'meter_credit'
                || grant.benefit.properties?.meter_id !== AI_CREDITS_METER_ID
                || grant.benefit.properties.units !== credits || grant.benefit.properties.rollover !== true) {
                throw new Error('Gift grant permanent credit confirmation is missing');
            }
            return grant;
        }
        if (page >= result.pagination.max_page) return null;
    }
    throw new Error('Gift credit grant lookup requires support');
}
