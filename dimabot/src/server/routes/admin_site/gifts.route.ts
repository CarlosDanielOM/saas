import express from 'express';
import type { Types } from 'mongoose';
import { CreditGiftSchema, type ICreditGift } from '../../../schemas/credit_gift.schema.js';
import UsersSchema from '../../../schemas/users.schema.js';
import { scrubSensitive } from '../../../utils/scrub_text.js';
import {
    AdminRequestError, channelIdForLogin, creditsToUSD, decodeCursor, encodeCursor, ownerGet, ownerPost, queryEnum, queryInt,
    queryLogin, queryString, reply
} from './shared.js';

/**
 * Owner-only view of gifted AI credit purchases (`credit_gifts`), mounted under `/admin-site`.
 *
 * A gift is paid by the buyer in one Polar checkout, then delivered to the recipient as a free order that
 * grants permanent credits, then announced in the recipient's chat. The worker in
 * `utils/credit_gifts.ts` runs those stages. These routes only read the receipts and can ask the worker to
 * try a paid, undelivered gift again now; they never call Polar or change money.
 */
const router = express.Router();

export const GIFT_FILTERS = ['needs_support', 'in_progress', 'awaiting_payment', 'delivered', 'expired', 'all'] as const;
export type GiftFilter = typeof GIFT_FILTERS[number];
const GIFT_ID = /^[a-f0-9]{64}$/;
const ERROR_MAX = 300;
const QUERY_MS = 5_000;

const PAID = { paidAt: { $exists: true, $ne: null } };
const UNPAID = { $or: [{ paidAt: { $exists: false } }, { paidAt: null }] };

/** Each filter as a Mongo match. `needs_support` before payment is an old flag from transient errors: it counts as awaiting payment. */
const FILTER_MATCH: Record<Exclude<GiftFilter, 'all'>, Record<string, unknown>> = {
    needs_support: { status: 'needs_support', ...PAID },
    in_progress: { status: { $in: ['payment_received', 'delivering'] } },
    awaiting_payment: { status: { $in: ['awaiting_payment', 'needs_support'] }, ...UNPAID },
    delivered: { status: 'delivered' },
    expired: { status: 'expired' },
};

export interface AdminGiftRow {
    id: string;
    /** Stored status. `needs_support` with `paid: false` is an old flag; the buyer never paid. */
    status: ICreditGift['status'];
    paid: boolean;
    buyer: { login: string; channelID: string | null };
    recipient: { login: string; displayName: string; channelID: string };
    credits: number;
    /** What the credits are worth at 100,000 credits per USD. */
    creditsUSD: number;
    /** What the buyer was charged, in the currency's minor unit (cents), before tax. */
    priceAmount: number;
    priceCurrency: string;
    createdAt: string;
    paidAt: string | null;
    deliveryStartedAt: string | null;
    deliveredAt: string | null;
    expiredAt: string | null;
    announcedAt: string | null;
    announcementStoppedAt: string | null;
    announcementAttempts: number;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
    /** The worker holds it right now. */
    processing: boolean;
    /** Polar references for looking the purchase up in the Polar dashboard. Never customer ids or checkout secrets. */
    refs: { checkoutId: string | null; paidOrderId: string | null; deliveryCheckoutId: string | null; deliveryOrderId: string | null; grantId: string | null };
}

const iso = (value: Date | string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function toRow(gift: ICreditGift, buyerChannels: Map<string, string>, now: Date): AdminGiftRow {
    const error = typeof gift.lastError === 'string' && gift.lastError.trim() ? scrubSensitive(gift.lastError.trim()).slice(0, ERROR_MAX) : null;
    return {
        id: gift._id,
        status: gift.status,
        paid: Boolean(gift.paidAt),
        buyer: { login: gift.buyerLogin, channelID: buyerChannels.get(String(gift.buyerId)) ?? null },
        recipient: { login: gift.recipientLogin, displayName: gift.recipientName || gift.recipientLogin, channelID: gift.recipientChannelId },
        credits: gift.credits,
        creditsUSD: creditsToUSD(gift.credits),
        priceAmount: gift.priceAmount,
        priceCurrency: gift.priceCurrency,
        createdAt: iso(gift.createdAt)!,
        paidAt: iso(gift.paidAt),
        deliveryStartedAt: iso(gift.fulfillmentCreateStartedAt),
        deliveredAt: iso(gift.deliveredAt),
        expiredAt: iso(gift.expiredAt),
        announcedAt: iso(gift.announcedAt),
        announcementStoppedAt: iso(gift.announcementStoppedAt),
        announcementAttempts: gift.announcementAttempts || 0,
        attempts: gift.attempts || 0,
        lastError: error,
        nextAttemptAt: gift.status === 'expired' || (gift.status === 'delivered' && (gift.announcedAt || gift.announcementStoppedAt)) ? null : iso(gift.nextAttemptAt),
        processing: Boolean(gift.leaseUntil && new Date(gift.leaseUntil).getTime() > now.getTime()),
        refs: {
            checkoutId: gift.checkoutId || null,
            paidOrderId: gift.paidOrderId || null,
            deliveryCheckoutId: gift.fulfillmentCheckoutId || null,
            deliveryOrderId: gift.fulfillmentOrderId || null,
            grantId: gift.grantId || null,
        },
    };
}

/** Buyer user id → their Twitch channel id, for linking the buyer to a channel workspace. */
async function buyerChannelIds(gifts: ICreditGift[]): Promise<Map<string, string>> {
    const ids = [...new Set(gifts.map(gift => String(gift.buyerId)))];
    const map = new Map<string, string>();
    if (!ids.length) return map;
    const users = await UsersSchema.find({ _id: { $in: ids } }).select('accounts.type accounts.id').maxTimeMS(QUERY_MS).lean();
    for (const user of users) {
        const account = user.accounts?.find(item => item.type === 'twitch' && item.id);
        if (account) map.set(String(user._id), String(account.id));
    }
    return map;
}

/** A channel by Twitch id or login → a match on gifts it sent or received. Null when no account has it. */
async function channelMatch(value: unknown): Promise<Record<string, unknown> | null | undefined> {
    const text = queryString(value, 'channel');
    if (text === undefined) return undefined;
    const channelID = /^\d{1,20}$/.test(text) ? text : await channelIdForLogin(queryLogin(text, 'channel')!);
    if (!channelID) return null;
    const owner = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } })
        .select('_id').maxTimeMS(QUERY_MS).lean<{ _id: Types.ObjectId }>();
    return { $or: [{ recipientChannelId: channelID }, ...(owner ? [{ buyerId: owner._id }] : [])] };
}

function giftID(value: unknown): string {
    if (typeof value !== 'string' || !GIFT_ID.test(value)) throw new AdminRequestError('Gift not found', 404);
    return value;
}

/** Counts per filter, for the chips. Small collection: one aggregate over the matching gifts. */
async function giftCounts(scope: Record<string, unknown>): Promise<Record<GiftFilter, number>> {
    const groups = await CreditGiftSchema.aggregate<{ _id: { status: string; paid: boolean }; n: number }>([
        { $match: scope },
        { $group: { _id: { status: '$status', paid: { $gt: ['$paidAt', null] } }, n: { $sum: 1 } } },
    ]).option({ maxTimeMS: QUERY_MS });
    const counts: Record<GiftFilter, number> = { needs_support: 0, in_progress: 0, awaiting_payment: 0, delivered: 0, expired: 0, all: 0 };
    for (const { _id, n } of groups) {
        counts.all += n;
        if (_id.status === 'needs_support') counts[_id.paid ? 'needs_support' : 'awaiting_payment'] += n;
        else if (_id.status === 'payment_received' || _id.status === 'delivering') counts.in_progress += n;
        else if (_id.status === 'awaiting_payment') counts.awaiting_payment += n;
        else if (_id.status === 'delivered') counts.delivered += n;
        else if (_id.status === 'expired') counts.expired += n;
    }
    return counts;
}

/** GET /gifts?status=&channel=&cursor=&limit= — newest first. */
ownerGet(router, '/gifts', async (req) => {
    const filter = queryEnum(req.query.status, 'status', GIFT_FILTERS, 'all');
    const limit = queryInt(req.query.limit, 'limit', 25, 1, 50);
    const cursor = decodeCursor(req.query.cursor);
    if (cursor && !GIFT_ID.test(cursor.id)) throw new AdminRequestError('Invalid cursor');
    const channel = await channelMatch(req.query.channel);
    const empty = { rows: [], next: null, counts: { needs_support: 0, in_progress: 0, awaiting_payment: 0, delivered: 0, expired: 0, all: 0 } };
    if (channel === null) return empty;

    const scope: Record<string, unknown> = channel ? { ...channel } : {};
    const conditions: Record<string, unknown>[] = [scope];
    if (filter !== 'all') conditions.push(FILTER_MATCH[filter]);
    if (cursor) conditions.push({ $or: [{ createdAt: { $lt: cursor.at } }, { createdAt: cursor.at, _id: { $lt: cursor.id } }] });
    const match = { $and: conditions };

    const [gifts, counts] = await Promise.all([
        CreditGiftSchema.find(match).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).maxTimeMS(QUERY_MS).lean<ICreditGift[]>(),
        giftCounts(scope),
    ]);
    const page = gifts.slice(0, limit);
    const buyers = await buyerChannelIds(page);
    const now = new Date();
    const last = page.at(-1);
    return {
        rows: page.map(gift => toRow(gift, buyers, now)),
        next: gifts.length > limit && last ? encodeCursor({ at: new Date(last.createdAt), id: last._id }) : null,
        counts,
    };
});

/** GET /gifts/:id — one gift. */
ownerGet(router, '/gifts/:id', async (req) => {
    const id = giftID(req.params.id);
    const gift = await CreditGiftSchema.findById(id).maxTimeMS(QUERY_MS).lean<ICreditGift>();
    if (!gift) throw new AdminRequestError('Gift not found', 404);
    return toRow(gift, await buyerChannelIds([gift]), new Date());
});

/**
 * POST /gifts/:id/retry — asks the worker to run the next stage of a paid, undelivered gift now instead of
 * waiting for its backoff. It does not skip any check: the worker still verifies the payment and never
 * creates a second delivery.
 */
ownerPost(router, '/gifts/:id/retry', async (req) => {
    const id = giftID(req.params.id);
    const now = new Date();
    const gift = await CreditGiftSchema.findById(id).maxTimeMS(QUERY_MS).lean<ICreditGift>();
    if (!gift) throw new AdminRequestError('Gift not found', 404);
    if (!gift.paidAt) throw new AdminRequestError('This gift was never paid, so there is nothing to deliver', 409);
    if (gift.deliveredAt) throw new AdminRequestError('These credits were already delivered', 409);
    if (gift.leaseUntil && new Date(gift.leaseUntil).getTime() > now.getTime()) {
        throw new AdminRequestError('The bot is working on this gift right now. Check again in a minute.', 409);
    }
    const result = await CreditGiftSchema.updateOne(
        { _id: id, paidAt: { $exists: true, $ne: null }, deliveredAt: { $exists: false },
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
        { $set: { nextAttemptAt: now } },
        { maxTimeMS: QUERY_MS },
    );
    if (!result.matchedCount) throw new AdminRequestError('The gift changed while retrying. Reload and try again.', 409);
    const fresh = await CreditGiftSchema.findById(id).maxTimeMS(QUERY_MS).lean<ICreditGift>();
    return reply(toRow(fresh!, await buyerChannelIds([fresh!]), new Date()), 'The bot will try this gift again within a few seconds');
});

export const adminGiftsRouter = router;
