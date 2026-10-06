import type { DomainEventEnvelope } from './domain_event.types.js';
import { acceptCreditGiftPaidOrder } from '../utils/credit_gifts.js';
import { GIFT_PACK_PAIRS } from '../utils/credit_gift_provider.js';

export async function applyCreditGiftDomainEvent(event: DomainEventEnvelope): Promise<void> {
    if (event.source !== 'polar-webhook' || event.type !== 'billing.order.paid') return;
    if (!GIFT_PACK_PAIRS.some(p => p.productId === event.payload.productId)) return;
    const orderId = event.payload.orderId;
    if (typeof orderId !== 'string' || event.payload.paid !== true) throw new Error('Gift requires a paid order');
    await acceptCreditGiftPaidOrder(orderId);
}
