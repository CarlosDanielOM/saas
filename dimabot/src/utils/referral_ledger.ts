import { Types } from 'mongoose';
import UsersSchema from '../schemas/users.schema.js';
import { CreditTransactionSchema } from '../schemas/credit_transaction.schema.js';
import { COMPLETED_REFERRAL_REWARD_FILTER } from './referral.js';

export const REFERRAL_LEDGER_PAGE_SIZE = 20;

export interface ReferralPerson {
    id: string;
    name: string;
    code: string;
    signedUpAt: Date;
    tier: 'free' | 'premium' | 'pro';
    creditsEarned: number;
}

export interface ReferralTimelineEvent {
    id: string;
    kind: 'signup' | 'reward';
    userId: string;
    name: string;
    code: string;
    at: Date;
    credits: number;
}

export interface ReferralLedgerPage<T> {
    items: T[];
    page: number;
    hasMore: boolean;
}

export async function getReferralPeoplePage(ownerId: Types.ObjectId, page: number): Promise<ReferralLedgerPage<ReferralPerson>> {
    const users = await UsersSchema.find({
        referrerId: ownerId,
        referralCodeUsed: { $type: 'string' },
    }).select('_id name plan_tier created_at referralCodeUsed')
        .sort({ created_at: -1, _id: -1 })
        .skip(page * REFERRAL_LEDGER_PAGE_SIZE)
        .limit(REFERRAL_LEDGER_PAGE_SIZE + 1)
        .lean();
    const visible = users.slice(0, REFERRAL_LEDGER_PAGE_SIZE);
    const ids = visible.map((user) => user._id);
    const totals = ids.length ? await CreditTransactionSchema.aggregate<{ _id: Types.ObjectId; credits: number }>([
        { $match: {
            user: ownerId,
            amount: { $gt: 0 },
            'metadata.referredUserId': { $in: ids },
            $or: COMPLETED_REFERRAL_REWARD_FILTER,
        } },
        { $group: { _id: '$metadata.referredUserId', credits: { $sum: '$amount' } } },
    ]) : [];
    const earnedByUser = new Map(totals.map((row) => [String(row._id), row.credits]));

    return {
        page,
        hasMore: users.length > REFERRAL_LEDGER_PAGE_SIZE,
        items: visible.map((user) => ({
            id: String(user._id),
            name: user.name,
            code: user.referralCodeUsed ?? '',
            signedUpAt: user.created_at,
            tier: user.plan_tier,
            creditsEarned: earnedByUser.get(String(user._id)) ?? 0,
        })),
    };
}

interface RawTimelineEvent {
    _id: Types.ObjectId;
    kind: 'signup' | 'reward';
    userId: Types.ObjectId;
    code: string | null;
    at: Date;
    credits: number;
}

export async function getReferralTimelinePage(ownerId: Types.ObjectId, page: number): Promise<ReferralLedgerPage<ReferralTimelineEvent>> {
    const rows = await UsersSchema.aggregate<RawTimelineEvent>([
        { $match: { referrerId: ownerId, referralCodeUsed: { $type: 'string' } } },
        { $project: {
            userId: '$_id', code: '$referralCodeUsed',
            at: { $ifNull: ['$created_at', { $toDate: '$_id' }] },
            kind: { $literal: 'signup' }, credits: { $literal: 0 },
        } },
        { $unionWith: {
            coll: CreditTransactionSchema.collection.name,
            pipeline: [
                { $match: {
                    user: ownerId,
                    amount: { $gt: 0 },
                    'metadata.referredUserId': { $type: 'objectId' },
                    $or: COMPLETED_REFERRAL_REWARD_FILTER,
                } },
                { $project: {
                    userId: '$metadata.referredUserId', code: '$metadata.referralCodeUsed',
                    at: { $ifNull: ['$appliedAt', '$createdAt'] },
                    kind: { $literal: 'reward' }, credits: '$amount',
                } },
            ],
        } },
        { $sort: { at: -1, _id: -1 } },
        { $skip: page * REFERRAL_LEDGER_PAGE_SIZE },
        { $limit: REFERRAL_LEDGER_PAGE_SIZE + 1 },
    ]);
    const visible = rows.slice(0, REFERRAL_LEDGER_PAGE_SIZE);
    const users = await UsersSchema.find({ _id: { $in: visible.map((row) => row.userId) } })
        .select('_id name').lean();
    const names = new Map(users.map((user) => [String(user._id), user.name]));

    return {
        page,
        hasMore: rows.length > REFERRAL_LEDGER_PAGE_SIZE,
        items: visible.map((row) => ({
            id: `${row.kind}:${row._id}`,
            kind: row.kind,
            userId: String(row.userId),
            name: names.get(String(row.userId)) ?? '',
            code: row.code ?? '',
            at: row.at,
            credits: row.credits,
        })),
    };
}
