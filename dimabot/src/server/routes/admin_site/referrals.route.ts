import express from 'express';
import { Types } from 'mongoose';
import UsersSchema, { type IUsers } from '../../../schemas/users.schema.js';
import { ReferralCodeSchema } from '../../../schemas/referral_code.schema.js';
import { CreditTransactionSchema } from '../../../schemas/credit_transaction.schema.js';
import { COMPLETED_REFERRAL_REWARD_FILTER } from '../../../utils/referral.js';
import {
    AdminRequestError, channelIdForLogin, decodeCursor, encodeCursor, ownerGet, ownerPut, queryInt, queryLogin, reply, type AuthRequest
} from './shared.js';

/**
 * Owner view and editing of referrals, mounted under `/admin-site`.
 *
 * A referral lives on the referred user: `referrerId` (who invited them) and `referralCodeUsed` (which of the
 * referrer's codes). The referrer's rewards need that code to be one of the referrer's active codes
 * (`utils/referral.ts`, `utils/paid_order_reward.ts`); the 10% first-subscription discount needs a code and
 * no `referralSource: 'manual'` (`utils/billing.ts`). A referrer set here is always `manual`: the referrer
 * is rewarded as usual, the referred person gets no discount. Rewards already paid are never moved.
 */
const router = express.Router();
const QUERY_MS = 5_000;
const PAGE = 50;

type Lean = Pick<IUsers, 'accounts' | 'plan_tier' | 'created_at' | 'referrerId' | 'referralCodeUsed' | 'referralSource' | 'referralSetAt'> & { _id: Types.ObjectId };
const USER_FIELDS = '_id accounts.type accounts.id accounts.name plan_tier created_at referrerId referralCodeUsed referralSource referralSetAt';

const twitch = (user: Pick<IUsers, 'accounts'> | null | undefined) => user?.accounts?.find(account => account.type === 'twitch' && account.id);
const login = (user: Pick<IUsers, 'accounts'> | null | undefined) => String(twitch(user)?.name || '');

async function userByChannel(channelID: string): Promise<Lean | null> {
    return UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select(USER_FIELDS).maxTimeMS(QUERY_MS).lean<Lean>();
}

function pathChannel(req: AuthRequest): string {
    const value = String(req.params.channelID || '');
    if (!/^\d{1,20}$/.test(value)) throw new AdminRequestError('Channel not found', 404);
    return value;
}

/** A person by Twitch channel id or login. */
async function resolvePerson(value: unknown): Promise<Lean | null> {
    if (typeof value !== 'string' || !value.trim()) throw new AdminRequestError('Choose who invited them');
    const text = value.trim().replace(/^@/, '');
    const channelID = /^\d{1,20}$/.test(text) ? text : await channelIdForLogin(queryLogin(text, 'referrer')!);
    return channelID ? userByChannel(channelID) : null;
}

/** Where a referral came from: `manual` (set here), `code` (signed up with a code), `unknown` (old row without either). */
function source(user: Pick<Lean, 'referralSource' | 'referralCodeUsed'>): 'manual' | 'code' | 'unknown' {
    if (user.referralSource === 'manual') return 'manual';
    return user.referralCodeUsed ? 'code' : 'unknown';
}

/**
 * Rewards for this referral reach the referrer only while the referrer's account exists and the code is one of
 * their active codes (the same two checks the payouts make).
 */
async function rewardsReferrer(user: Pick<Lean, 'referrerId' | 'referralCodeUsed'>, referrerExists: boolean): Promise<boolean> {
    if (!referrerExists || !user.referrerId || !user.referralCodeUsed) return false;
    return Boolean(await ReferralCodeSchema.exists({ code: user.referralCodeUsed.toLowerCase(), owner: user.referrerId, active: true }).maxTimeMS(QUERY_MS));
}

async function view(person: Lean, cursorValue?: unknown, limit = PAGE) {
    const cursor = decodeCursor(cursorValue);
    if (cursor && !Types.ObjectId.isValid(cursor.id)) throw new AdminRequestError('Invalid cursor');

    const referrer = person.referrerId
        ? await UsersSchema.findById(person.referrerId).select(USER_FIELDS).maxTimeMS(QUERY_MS).lean<Lean>()
        : null;
    const codes = await ReferralCodeSchema.find({ owner: person._id }).sort({ createdAt: 1 }).maxTimeMS(QUERY_MS).lean();
    // Per code, like the streamer's own referral stats (`getReferralStats`): sign-ups from the users, conversions
    // from completed reward receipts (each invited person once). The code's stored counter is no longer kept up.
    const codeNames = codes.map(code => code.code);
    const [signups, conversions] = await Promise.all([
        UsersSchema.aggregate<{ _id: string; total: number }>([
            { $match: { referrerId: person._id, referralCodeUsed: { $in: codeNames } } },
            { $group: { _id: '$referralCodeUsed', total: { $sum: 1 } } },
        ]).option({ maxTimeMS: QUERY_MS }),
        CreditTransactionSchema.aggregate<{ _id: string; total: number }>([
            { $match: { user: person._id, 'metadata.referralCodeUsed': { $in: codeNames }, 'metadata.referredUserId': { $type: 'objectId' }, $or: COMPLETED_REFERRAL_REWARD_FILTER } },
            { $group: { _id: { code: '$metadata.referralCodeUsed', referredUserId: '$metadata.referredUserId' } } },
            { $group: { _id: '$_id.code', total: { $sum: 1 } } },
        ]).option({ maxTimeMS: QUERY_MS }),
    ]);
    const signupsBy = new Map(signups.map(row => [row._id, row.total]));
    const conversionsBy = new Map(conversions.map(row => [row._id, row.total]));

    const match: Record<string, unknown> = { referrerId: person._id };
    const pageMatch = cursor
        ? { ...match, $or: [{ created_at: { $lt: cursor.at } }, { created_at: cursor.at, _id: { $lt: new Types.ObjectId(cursor.id) } }] }
        : match;
    const [rows, referredTotal, earned] = await Promise.all([
        UsersSchema.find(pageMatch).select(USER_FIELDS).sort({ created_at: -1, _id: -1 }).limit(limit + 1).maxTimeMS(QUERY_MS).lean<Lean[]>(),
        UsersSchema.countDocuments(match).maxTimeMS(QUERY_MS),
        CreditTransactionSchema.aggregate<{ _id: Types.ObjectId | null; credits: number }>([
            { $match: { user: person._id, amount: { $gt: 0 }, 'metadata.referredUserId': { $type: 'objectId' }, $or: COMPLETED_REFERRAL_REWARD_FILTER } },
            { $group: { _id: '$metadata.referredUserId', credits: { $sum: '$amount' } } },
        ]).option({ maxTimeMS: QUERY_MS }),
    ]);
    const page = rows.slice(0, limit);
    const earnedBy = new Map(earned.map(row => [String(row._id), row.credits]));
    const last = page.at(-1);

    return {
        person: { userId: String(person._id), login: login(person), channelID: String(twitch(person)?.id || ''), plan: person.plan_tier },
        referredBy: person.referrerId ? {
            userId: String(person.referrerId),
            // Null when the referrer's account was deleted.
            login: referrer ? login(referrer) || null : null,
            channelID: referrer ? String(twitch(referrer)?.id || '') || null : null,
            code: person.referralCodeUsed || null,
            source: source(person),
            setAt: person.referralSetAt ? new Date(person.referralSetAt).toISOString() : null,
            rewardsReferrer: await rewardsReferrer(person, Boolean(referrer)),
            // The 10% first-subscription discount (whether they already subscribed is checked at checkout).
            discount: Boolean(person.referralCodeUsed) && person.referralSource !== 'manual',
        } : null,
        codes: codes.map(code => ({
            code: code.code, label: code.label || '', active: code.active !== false,
            signups: signupsBy.get(code.code) ?? 0,
            conversions: conversionsBy.get(code.code) ?? 0, createdAt: code.createdAt ? new Date(code.createdAt).toISOString() : null,
        })),
        referred: page.map(user => ({
            userId: String(user._id),
            login: login(user),
            channelID: String(twitch(user)?.id || '') || null,
            plan: user.plan_tier,
            code: user.referralCodeUsed || null,
            source: source(user),
            signedUpAt: user.created_at ? new Date(user.created_at).toISOString() : null,
            creditsEarned: earnedBy.get(String(user._id)) ?? 0,
        })),
        referredTotal,
        creditsEarnedTotal: earned.reduce((sum, row) => sum + row.credits, 0),
        next: rows.length > limit && last ? encodeCursor({ at: new Date(last.created_at), id: String(last._id) }) : null,
    };
}

/** GET /users/:channelID/referrals — who invited them, their codes, and the people they invited (cursor pages). */
ownerGet(router, '/users/:channelID/referrals', async (req) => {
    const person = await userByChannel(pathChannel(req));
    if (!person) throw new AdminRequestError('Channel not found', 404);
    return view(person, req.query.cursor, queryInt(req.query.limit, 'limit', PAGE, 1, 100));
});

/**
 * PUT /users/:channelID/referrer — set, move or remove who invited this person.
 * Body: `{ referrer: <channel id or login> | null, code?: string, replace?: boolean, expectedReferrer?: <user id> | null }`.
 * Without `code` the referrer's oldest active code is used (none: stored without a code, and the referrer earns
 * no rewards for it). Moving someone already invited by another person needs `replace: true` (409 says who it
 * is now). `expectedReferrer` is who the page showed as the inviter (null = nobody): when it changed meanwhile
 * (another tab or person), nothing is written and a 409 asks to reload. Every write is compare-and-set on the
 * inviter that was read, so two saves never overwrite each other silently.
 */
ownerPut(router, '/users/:channelID/referrer', async (req) => {
    const person = await userByChannel(pathChannel(req));
    if (!person) throw new AdminRequestError('Channel not found', 404);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { referrer?: unknown; code?: unknown; replace?: unknown; expectedReferrer?: unknown };
    const changed = () => new AdminRequestError('Who invited them changed since this page loaded. Reload and try again.', 409);
    const currentReferrer = person.referrerId ? String(person.referrerId) : null;
    if (body.expectedReferrer !== undefined) {
        if (body.expectedReferrer !== null && (typeof body.expectedReferrer !== 'string' || !Types.ObjectId.isValid(body.expectedReferrer))) {
            throw new AdminRequestError('Invalid expectedReferrer');
        }
        if (body.expectedReferrer !== currentReferrer) throw changed();
    }
    // Compare-and-set on the inviter read above (null also matches a missing field).
    const unchanged = { _id: person._id, referrerId: person.referrerId ?? null };

    if (body.referrer === null) {
        const removed = await UsersSchema.updateOne(unchanged,
            { $set: { referrerId: null, referralCodeUsed: null, referralSource: null, referralSetAt: null } }).maxTimeMS(QUERY_MS);
        if (!removed.matchedCount) throw changed();
        const fresh = await userByChannel(pathChannel(req));
        return reply(await view(fresh!), 'Referrer removed');
    }

    const referrer = await resolvePerson(body.referrer);
    if (!referrer) throw new AdminRequestError('No account has that channel', 404);
    if (String(referrer._id) === String(person._id)) throw new AdminRequestError("Someone can't invite themselves");

    if (person.referrerId && String(person.referrerId) !== String(referrer._id) && body.replace !== true) {
        const current = await UsersSchema.findById(person.referrerId).select('accounts.type accounts.id accounts.name').maxTimeMS(QUERY_MS).lean();
        throw new AdminRequestError(`${login(person) || 'This person'} was invited by ${login(current) || 'a deleted account'}${person.referralCodeUsed ? ` (code ${person.referralCodeUsed})` : ''}. Confirm to move them.`, 409);
    }

    let code: string | null;
    if (body.code !== undefined && body.code !== null) {
        if (typeof body.code !== 'string' || !/^[a-zA-Z0-9_]{1,16}$/.test(body.code)) throw new AdminRequestError('Invalid code');
        const owned = await ReferralCodeSchema.findOne({ code: body.code.toLowerCase(), owner: referrer._id }).maxTimeMS(QUERY_MS).lean();
        if (!owned) throw new AdminRequestError(`${login(referrer)} has no code "${body.code}"`);
        code = owned.code;
    } else {
        const oldest = await ReferralCodeSchema.findOne({ owner: referrer._id, active: true }).sort({ createdAt: 1 }).maxTimeMS(QUERY_MS).lean();
        code = oldest?.code ?? null;
    }

    const saved = await UsersSchema.updateOne(unchanged,
        { $set: { referrerId: referrer._id, referralCodeUsed: code, referralSource: 'manual', referralSetAt: new Date() } }).maxTimeMS(QUERY_MS);
    if (!saved.matchedCount) throw changed();
    const fresh = await userByChannel(pathChannel(req));
    return reply(await view(fresh!), code ? `Now invited by ${login(referrer)} (code ${code})` : `Now invited by ${login(referrer)}, without a code`);
});

export const adminReferralsRouter = router;
