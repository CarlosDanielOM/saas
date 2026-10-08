import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import UsersSchema, { type IUsers } from '../schemas/users.schema.js';
import { CreditGiftSchema, type ICreditGift } from '../schemas/credit_gift.schema.js';
import { getAiCredits } from './billing.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import { sendTwitchChatMessage } from '../functions/chats/send_message.chat.js';
import {
    GIFT_PACK_PAIRS, GiftProviderError, giftPolarRequest, getGiftCheckoutOrder, getGiftCreditGrant,
    loadGiftPair, recoverGiftCheckout, type GiftCheckout, type GiftOrder, type GiftOffer,
} from './credit_gift_provider.js';

const WRITE = { writeConcern: { w: 1 as const, j: true }, maxTimeMS: 5_000 };
const LEASE_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CreditGiftRequestError extends Error {
    constructor(message: string, readonly statusCode = 400) { super(message); }
}

export interface GiftRecipient { id: string; login: string; displayName: string; avatarUrl: null }

function twitchAccount(user: IUsers) {
    return user.accounts.find(a => a.type === 'twitch' && a.id && a.name);
}

function recipientView(user: IUsers): GiftRecipient {
    const account = twitchAccount(user);
    if (!account) throw new CreditGiftRequestError('This account has no Twitch channel', 404);
    return { id: user._id.toString(), login: account.name.toLowerCase(), displayName: account.name, avatarUrl: null };
}

export async function findGiftRecipient(login: string): Promise<GiftRecipient> {
    const normalized = login.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(normalized)) throw new CreditGiftRequestError('Enter an exact Twitch channel name');
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', name: { $regex: `^${normalized}$`, $options: 'i' } } } }).lean().maxTimeMS(5_000);
    if (!user) throw new CreditGiftRequestError('This channel does not have a bot account', 404);
    return recipientView(user);
}

function giftView(gift: ICreditGift) {
    return {
        id: gift._id, status: gift.status,
        recipient: { id: gift.recipientId.toString(), login: gift.recipientLogin, displayName: gift.recipientName },
        credits: gift.credits, paidAt: gift.paidAt?.toISOString() ?? null, deliveredAt: gift.deliveredAt?.toISOString() ?? null,
    };
}

export async function getCreditGift(id: string, user: IUsers) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new CreditGiftRequestError('Gift not found', 404);
    const gift = await CreditGiftSchema.findOne({ _id: id, $or: [{ buyerId: user._id }, { recipientId: user._id }] }).lean().maxTimeMS(5_000);
    if (!gift) throw new CreditGiftRequestError('Gift not found', 404);
    return giftView(gift);
}

function redirectUrl(raw: string | undefined, fallback: string): URL {
    const value = raw || process.env[fallback] || 'https://domdimabot.com';
    let url: URL;
    try { url = new URL(value); } catch { throw new CreditGiftRequestError('Invalid return URL'); }
    const hosts = (process.env.BILLING_ALLOWED_REDIRECT_HOSTS || 'domdimabot.com,www.domdimabot.com').split(',').map(v => v.trim().toLowerCase());
    if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.host.toLowerCase())) {
        throw new CreditGiftRequestError('Invalid return URL');
    }
    return url;
}

function customerPayload(user: IUsers): Record<string, unknown> {
    if (!UUID.test(user.polar_sh_customer_id || '')) throw new CreditGiftRequestError('This billing account is not ready. Please sign in again or contact support.', 409);
    return {
        customer_id: user.polar_sh_customer_id,
        external_customer_id: user._id.toString(), customer_email: user.email, customer_name: user.name,
    };
}

async function verifyGiftCustomer(user: IUsers): Promise<void> {
    customerPayload(user);
    const customer = await giftPolarRequest<{ id: string; external_id: string | null; deleted_at: string | null }>(`/v1/customers/${user.polar_sh_customer_id}`);
    if (customer.id !== user.polar_sh_customer_id || customer.deleted_at
        || (customer.external_id && customer.external_id !== user._id.toString())) {
        throw new CreditGiftRequestError('This billing account needs support before it can receive or buy gifts.', 409);
    }
}

function requireCheckout(checkout: GiftCheckout, gift: ICreditGift, user: IUsers, fulfillment: boolean): void {
    const productId = fulfillment ? gift.fulfillmentProductId : gift.productId;
    const source = fulfillment ? 'dimabot_gift_fulfillment' : 'dimabot_gift_purchase';
    const linkedCustomer = UUID.test(user.polar_sh_customer_id || '') ? user.polar_sh_customer_id : null;
    const ownerMatches = checkout.customer_external_id === user._id.toString()
        || (!checkout.customer_external_id && linkedCustomer && checkout.customer_id === linkedCustomer);
    if (!checkout.id || checkout.product_id !== productId || !ownerMatches
        || checkout.metadata?.gift_id !== gift._id || checkout.metadata.source !== source) throw new Error('Gift checkout identity mismatch');
    if (checkout.amount !== (fulfillment ? 0 : gift.priceAmount) || checkout.discount_amount !== 0
        || checkout.currency !== gift.priceCurrency) throw new Error('Gift checkout price changed');
    if (fulfillment && (checkout.total_amount !== 0 || checkout.currency !== gift.priceCurrency)) throw new Error('Gift fulfillment must be free');
    if (fulfillment && checkout.metadata.parent_order_id !== gift.paidOrderId) throw new Error('Gift fulfillment parent changed');
}

export function validateGiftOrder(order: GiftOrder, gift: ICreditGift, user: IUsers, fulfillment: boolean): void {
    const customer = fulfillment ? gift.recipientCustomerId : gift.buyerCustomerId;
    const checkout = fulfillment ? gift.fulfillmentCheckoutId : gift.checkoutId;
    const product = fulfillment ? gift.fulfillmentProductId : gift.productId;
    const source = fulfillment ? 'dimabot_gift_fulfillment' : 'dimabot_gift_purchase';
    const ownerMatches = order.customer?.external_id === user._id.toString()
        || (!order.customer?.external_id && UUID.test(user.polar_sh_customer_id || '') && order.customer_id === user.polar_sh_customer_id);
    if (order.paid !== true || order.status !== 'paid' || order.subscription_id || order.refunded_amount !== 0
        || order.discount_amount !== 0
        || order.checkout_id !== checkout || order.product_id !== product || order.customer_id !== customer
        || order.customer?.id !== customer || !ownerMatches || order.currency !== gift.priceCurrency
        || order.metadata?.gift_id !== gift._id || order.metadata.source !== source
        || (fulfillment ? order.total_amount !== 0 : order.total_amount <= 0)) throw new Error('Gift paid order identity or payment mismatch');
    if (fulfillment && order.metadata.parent_order_id !== gift.paidOrderId) throw new Error('Gift parent order mismatch');
    if (!fulfillment && gift.paidOrderId && order.id !== gift.paidOrderId) throw new Error('Gift paid order changed');
    if (fulfillment && gift.fulfillmentOrderId && order.id !== gift.fulfillmentOrderId) throw new Error('Gift fulfillment order changed');
}

export async function createCreditGiftCheckout(request: {
    user: IUsers; productId: string; recipientId: string; requestId: string;
    acknowledgeNoRefunds: boolean; successUrl?: string; returnUrl?: string;
}) {
    if (request.acknowledgeNoRefunds !== true) throw new CreditGiftRequestError('Confirm the recipient and gift refund policy');
    if (!UUID.test(request.requestId) || !Types.ObjectId.isValid(request.recipientId)
        || !GIFT_PACK_PAIRS.some(p => p.productId === request.productId)) throw new CreditGiftRequestError('Invalid gift purchase');
    if (request.user._id.toString() === request.recipientId) throw new CreditGiftRequestError('Choose another channel to receive the gift');
    const recipient = await UsersSchema.findById(request.recipientId).lean().maxTimeMS(5_000);
    if (!recipient) throw new CreditGiftRequestError('Recipient account no longer exists', 404);
    const recipientInfo = recipientView(recipient), buyerAccount = twitchAccount(request.user);
    if (!buyerAccount) throw new CreditGiftRequestError('A bot account is required', 403);
    const id = createHash('sha256').update(`${request.user._id}:${request.requestId.toLowerCase()}`).digest('hex');
    const success = redirectUrl(request.successUrl, 'BILLING_SUCCESS_URL');
    success.searchParams.set('gift_id', id);
    success.searchParams.set('gift', 'return');
    const back = redirectUrl(request.returnUrl, 'BILLING_RETURN_URL');
    const pair = await loadGiftPair(request.productId);
    // Refuse payment until both identities already exist in Polar; never resolve the recipient by email.
    await Promise.all([verifyGiftCustomer(request.user), verifyGiftCustomer(recipient)]);
    const now = new Date();
    await CreditGiftSchema.updateOne({ _id: id }, { $setOnInsert: {
        buyerId: request.user._id, recipientId: recipient._id, buyerLogin: buyerAccount.name.toLowerCase(),
        recipientLogin: recipientInfo.login, recipientName: recipientInfo.displayName, recipientChannelId: twitchAccount(recipient)!.id,
        productId: pair.offer.id, fulfillmentProductId: pair.fulfillmentProductId, benefitId: pair.benefitId,
        credits: pair.offer.credits, priceAmount: pair.offer.priceAmount, priceCurrency: pair.offer.priceCurrency,
        status: 'awaiting_payment', noRefundsAcknowledgedAt: now, nextAttemptAt: now,
    } }, { ...WRITE, upsert: true });
    let gift = await CreditGiftSchema.findById(id).select('+checkoutUrl').lean().maxTimeMS(5_000);
    if (!gift) throw new Error('Gift reservation missing');
    if (gift.productId !== request.productId || gift.recipientId.toString() !== request.recipientId) {
        throw new CreditGiftRequestError('A gift request cannot change recipient or pack; start a new gift', 409);
    }
    const response = (checkoutUrl: string) => ({ giftId: id, checkoutId: gift!.checkoutId, checkoutUrl, offer: {
        id: gift!.productId, name: pair.offer.name, credits: gift!.credits, rollover: true,
        priceAmount: gift!.priceAmount, priceCurrency: gift!.priceCurrency,
    } satisfies GiftOffer, recipient: { id: gift!.recipientId.toString(), login: gift!.recipientLogin, displayName: gift!.recipientName } });
    if (gift.paidAt) throw new CreditGiftRequestError('This gift has already been paid for', 409);
    if (gift.checkoutId && gift.checkoutUrl) return response(gift.checkoutUrl);
    // A persisted reservation precedes the external POST. Response loss cannot make another checkout.
    const claimed = await CreditGiftSchema.updateOne({ _id: id, purchaseCreateStartedAt: { $exists: false } },
        { $set: { purchaseCreateStartedAt: now } }, WRITE);
    let checkout: GiftCheckout | null;
    if (claimed.modifiedCount === 1) {
        checkout = await giftPolarRequest<GiftCheckout>('/v1/checkouts/', { method: 'POST',
            headers: { 'Idempotency-Key': `gift-purchase:${id}` },
            body: JSON.stringify({ products: [gift.productId], ...customerPayload(request.user), allow_discount_codes: false,
                success_url: success.toString(), return_url: back.toString(),
                metadata: { source: 'dimabot_gift_purchase', gift_id: id, recipient_id: gift.recipientId.toString(),
                    credits: gift.credits, rollover: true, no_automatic_refunds: true } }),
        });
    } else {
        checkout = await recoverGiftCheckout(id, gift.productId, gift.buyerId.toString());
        if (!checkout) throw new CreditGiftRequestError('Checkout is being prepared; retry this same gift shortly', 409);
    }
    requireCheckout(checkout, gift, request.user, false);
    if (checkout.status !== 'open') throw new CreditGiftRequestError('This checkout is no longer open; check the gift delivery status', 409);
    await CreditGiftSchema.updateOne({ _id: id, paidAt: { $exists: false } }, {
        $set: { checkoutId: checkout.id, checkoutUrl: checkout.url, buyerCustomerId: checkout.customer_id || undefined, nextAttemptAt: new Date() },
    }, WRITE);
    gift = { ...gift, checkoutId: checkout.id };
    return response(checkout.url);
}

/** Fast wakeup from a signed, journaled paid order. REST reconciliation also handles missed webhooks. */
export async function acceptCreditGiftPaidOrder(orderId: string): Promise<void> {
    const order = await giftPolarRequest<GiftOrder>(`/v1/orders/${encodeURIComponent(orderId)}`);
    if (order.metadata?.source !== 'dimabot_gift_purchase' || typeof order.metadata.gift_id !== 'string') return;
    const gift = await CreditGiftSchema.findById(order.metadata.gift_id).lean().maxTimeMS(5_000);
    if (!gift) throw new Error('Gift reservation missing for paid order');
    if (!gift.checkoutId) return; // API response-loss recovery owns checkout identity; worker will reconcile it.
    const buyer = await UsersSchema.findById(gift.buyerId).lean().maxTimeMS(5_000);
    if (!buyer) throw new Error('Gift buyer no longer exists');
    const checkout = await giftPolarRequest<GiftCheckout>(`/v1/checkouts/${gift.checkoutId}`);
    requireCheckout(checkout, gift, buyer, false);
    validateGiftOrder(order, { ...gift, buyerCustomerId: checkout.customer_id || undefined }, buyer, false);
    await CreditGiftSchema.updateOne({ _id: gift._id, paidAt: { $exists: false } }, {
        $set: { paidOrderId: order.id, buyerCustomerId: order.customer_id, paidAt: new Date(), status: 'payment_received', nextAttemptAt: new Date() },
    }, WRITE);
}

export function giftAnnouncement(gift: ICreditGift, language: 'en' | 'es'): string {
    const login = (value: string) => value.replace(/[^a-z0-9_]/gi, '').slice(0, 25);
    const credits = new Intl.NumberFormat(language === 'es' ? 'es-ES' : 'en-US').format(gift.credits);
    return language === 'es'
        ? `🎁 @${login(gift.buyerLogin)} regaló ${credits} créditos permanentes de IA a @${login(gift.recipientLogin)}. ¡Ya están disponibles! ¡Gracias!`
        : `🎁 @${login(gift.buyerLogin)} gifted ${credits} permanent AI credits to @${login(gift.recipientLogin)}. The credits are ready to use. Thank you!`;
}

async function refreshRecipientCredits(gift: ICreditGift): Promise<void> {
    const result = await UsersSchema.updateOne({ _id: gift.recipientId,
        $or: [{ polar_sh_customer_id: null }, { polar_sh_customer_id: '' }, { polar_sh_customer_id: gift.recipientCustomerId }] },
    { $set: { polar_sh_customer_id: gift.recipientCustomerId } }, WRITE);
    if (!result.matchedCount) throw new Error('Gift recipient customer mapping changed');
    const cache = await getDragonflyClient('credit-gift-delivery');
    await cache.del(`twitch:${gift.recipientChannelId}:ai:credits`);
    // Refresh the actual meter, including existing debt; never fabricate a local credit balance.
    const user = await UsersSchema.findById(gift.recipientId).lean().maxTimeMS(5_000);
    if (!user) throw new Error('Gift recipient account disappeared');
    await getAiCredits(user, gift.recipientChannelId, { requireVerified: true });
}

/** One bounded stage per lease. Tests inject only external chat/cache effects, keeping Mongo/Polar adapters real. */
export async function processCreditGift(injected: {
    refreshCredits?: typeof refreshRecipientCredits;
    sendChat?: typeof sendTwitchChatMessage;
} = {}): Promise<boolean> {
    const now = new Date(), token = randomUUID();
    const gift = await CreditGiftSchema.findOneAndUpdate({ nextAttemptAt: { $lte: now },
        $and: [
            { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
            { $or: [{ status: { $ne: 'delivered' } }, { announcedAt: { $exists: false }, announcementStoppedAt: { $exists: false } }] },
        ],
    }, { $set: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { ...WRITE, sort: { nextAttemptAt: 1 }, new: true }).lean();
    if (!gift) return false;
    const fence = () => ({ _id: gift._id, leaseToken: token, leaseUntil: { $gt: new Date() } });
    const update = async (values: Partial<ICreditGift>) => {
        const result = await CreditGiftSchema.updateOne(fence(), { $set: values }, WRITE);
        if (!result.matchedCount) throw new Error('Gift processing lease lost');
        Object.assign(gift, values);
    };
    const alive = async () => { if (!await CreditGiftSchema.exists(fence())) throw new Error('Gift processing lease lost'); };
    let delay = 5_000;
    try {
        const recipient = await UsersSchema.findById(gift.recipientId).lean().maxTimeMS(5_000);
        if (!recipient || twitchAccount(recipient)?.id !== gift.recipientChannelId) throw new Error('Gift recipient account changed or disappeared');
        if (gift.deliveredAt) {
            if (gift.announcedAt || gift.announcementStoppedAt) return true;
            // No online/offline gate: Helix chat is available in an offline channel too.
            await alive();
            await update({ announcementAttempts: gift.announcementAttempts + 1 });
            const result = await (injected.sendChat || sendTwitchChatMessage)(gift.recipientChannelId, giftAnnouncement(gift, recipient.language || 'en'));
            if (result.error) {
                if (result.type === 'held_for_moderation') {
                    await update({ announcementStoppedAt: new Date(), lastError: 'Gift announcement held for moderation' });
                    return true;
                }
                throw new Error('Gift chat announcement failed');
            }
            await update({ announcedAt: new Date(), announcementMessageId: result.data?.message_id, lastError: '' });
            return true;
        }
        if (!gift.paidAt) {
            const buyer = await UsersSchema.findById(gift.buyerId).lean().maxTimeMS(5_000);
            if (!buyer) throw new Error('Gift buyer no longer exists');
            if (!gift.checkoutId) {
                if (!gift.purchaseCreateStartedAt) { delay = 60_000; return true; }
                const recovered = await recoverGiftCheckout(gift._id, gift.productId, gift.buyerId.toString());
                if (!recovered) { delay = 60_000; return true; }
                requireCheckout(recovered, gift, buyer, false);
                await update({ checkoutId: recovered.id, buyerCustomerId: recovered.customer_id || undefined });
            }
            const order = await getGiftCheckoutOrder(gift.checkoutId!);
            if (!order || !order.paid) { delay = 30_000; return true; }
            const checkout = await giftPolarRequest<GiftCheckout>(`/v1/checkouts/${gift.checkoutId}`);
            requireCheckout(checkout, gift, buyer, false);
            validateGiftOrder(order, { ...gift, buyerCustomerId: checkout.customer_id || undefined }, buyer, false);
            await update({ paidOrderId: order.id, buyerCustomerId: order.customer_id, paidAt: new Date(), status: 'payment_received', lastError: '' });
            return true;
        }
        if (!gift.fulfillmentCheckoutId) {
            const pair = await loadGiftPair(gift.productId);
            if (pair.fulfillmentProductId !== gift.fulfillmentProductId || pair.benefitId !== gift.benefitId
                || pair.offer.credits !== gift.credits || pair.offer.priceAmount !== gift.priceAmount
                || pair.offer.priceCurrency !== gift.priceCurrency) throw new Error('Gift pack configuration changed after purchase');
            let checkout: GiftCheckout | null;
            if (gift.fulfillmentCreateStartedAt) {
                checkout = await recoverGiftCheckout(gift._id, gift.fulfillmentProductId, gift.recipientId.toString());
                if (!checkout) throw new Error('Gift fulfillment checkout creation is uncertain; reconciliation required');
            } else {
                // Recheck payment before the first benefit-bearing checkout is created.
                const buyer = await UsersSchema.findById(gift.buyerId).lean().maxTimeMS(5_000);
                if (!buyer) throw new Error('Gift buyer no longer exists');
                const paid = await giftPolarRequest<GiftOrder>(`/v1/orders/${gift.paidOrderId}`);
                validateGiftOrder(paid, gift, buyer, false);
                await verifyGiftCustomer(recipient);
                await update({ fulfillmentCreateStartedAt: new Date(), status: 'delivering' });
                await alive();
                checkout = await giftPolarRequest<GiftCheckout>('/v1/checkouts/', { method: 'POST',
                    headers: { 'Idempotency-Key': `gift-fulfillment:${gift._id}` },
                    body: JSON.stringify({ products: [gift.fulfillmentProductId], ...customerPayload(recipient), allow_discount_codes: false,
                        metadata: { source: 'dimabot_gift_fulfillment', gift_id: gift._id, parent_order_id: gift.paidOrderId,
                            credits: gift.credits, rollover: true } }),
                });
            }
            requireCheckout(checkout, gift, recipient, true);
            await update({ fulfillmentCheckoutId: checkout.id, recipientCustomerId: checkout.customer_id || undefined, status: 'delivering', lastError: '' });
            return true;
        }
        const checkout = await giftPolarRequest<GiftCheckout>(`/v1/checkouts/${gift.fulfillmentCheckoutId}`);
        requireCheckout(checkout, gift, recipient, true);
        if (checkout.status === 'open') {
            // Confirm only a known, persisted, zero-cost checkout. Never create a replacement.
            const buyer = await UsersSchema.findById(gift.buyerId).lean().maxTimeMS(5_000);
            if (!buyer) throw new Error('Gift buyer no longer exists');
            const paid = await giftPolarRequest<GiftOrder>(`/v1/orders/${gift.paidOrderId}`);
            validateGiftOrder(paid, gift, buyer, false);
            await alive();
            if (!checkout.client_secret) throw new Error('Gift fulfillment checkout secret missing');
            await giftPolarRequest(`/v1/checkouts/client/${encodeURIComponent(checkout.client_secret)}/confirm`, { method: 'POST', body: '{}' });
            return true;
        }
        if (checkout.status === 'failed' || checkout.status === 'expired') throw new Error('Gift fulfillment checkout failed or expired');
        const order = await getGiftCheckoutOrder(gift.fulfillmentCheckoutId);
        if (!order || !order.paid) return true;
        // Customer ID may only become available after checkout confirmation.
        if (!gift.recipientCustomerId && checkout.customer_id) await update({ recipientCustomerId: checkout.customer_id });
        validateGiftOrder(order, gift, recipient, true);
        await update({ fulfillmentOrderId: order.id });
        const grant = await getGiftCreditGrant(order.id, order.customer_id, gift.benefitId, gift.credits);
        if (!grant) return true;
        await (injected.refreshCredits || refreshRecipientCredits)(gift);
        await update({ grantId: grant.id, deliveredAt: new Date(), status: 'delivered', lastError: '' });
    } catch (error) {
        const message = error instanceof GiftProviderError ? error.message : error instanceof Error ? error.message : 'Gift delivery failed';
        console.error('Credit gift processing failed', { giftId: gift._id, stage: gift.status, error: message });
        const attempts = gift.attempts + 1;
        delay = Math.min(30 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 7));
        const values: Partial<ICreditGift> = { attempts, lastError: message };
        if (gift.deliveredAt) {
            if (gift.announcementAttempts >= 5) values.announcementStoppedAt = new Date();
        } else if (attempts >= 5) values.status = 'needs_support';
        await update(values);
    } finally {
        await CreditGiftSchema.updateOne(fence(), { $set: { nextAttemptAt: new Date(Date.now() + delay) }, $unset: { leaseToken: '', leaseUntil: '' } }, WRITE);
    }
    return true;
}
