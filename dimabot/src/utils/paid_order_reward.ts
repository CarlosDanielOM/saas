import { Types } from 'mongoose';
import UsersSchema from '../schemas/users.schema.js';
import { CreditTransactionSchema, TRANSACTION_TYPES } from '../schemas/credit_transaction.schema.js';
import { ReferralCodeSchema } from '../schemas/referral_code.schema.js';
import {
    getBotSubscriptionRewardAmount,
    getPlanTypeFromProductId,
    type SubscriptionCadence,
} from './referral.js';

export async function applyPaidOrderReward({ ownerUserId, orderId, productId, cadence }: {
    ownerUserId: string;
    orderId: string;
    productId: string;
    cadence: SubscriptionCadence;
}): Promise<void> {
    if (!orderId?.trim()) {
        throw new Error('Paid order reward requires an order ID');
    }

    // The unique index must be ready before any reservation can be created.
    await CreditTransactionSchema.init();
    const idempotencyKey = `polar:paid-order:${orderId}`;
    let reservation = await CreditTransactionSchema.findOne({ idempotencyKey });

    if (!reservation) {
        const planType = getPlanTypeFromProductId(productId);
        const amount = getBotSubscriptionRewardAmount(planType, cadence);
        if (amount <= 0) return;

        // Old paid-order rewards stored the order ID here. Exclude our own key:
        // a concurrent RESERVED row is not evidence that credit was applied.
        const legacyReward = await CreditTransactionSchema.exists({
            type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD,
            'metadata.subscriptionId': orderId,
            idempotencyKey: { $ne: idempotencyKey },
        });
        if (legacyReward) return;

        if (!Types.ObjectId.isValid(ownerUserId)) {
            throw new Error('Paid order reward requires a canonical owner user ID');
        }
        const payer = await UsersSchema.findById(ownerUserId);
        if (!payer) throw new Error('Paid order reward owner not found');

        let beneficiaryId: Types.ObjectId | undefined;
        let rewardTargetType: 'bot' | 'referrer' = 'bot';
        if (payer.referrerId && payer.referralCodeUsed) {
            const referralCode = await ReferralCodeSchema.exists({
                code: payer.referralCodeUsed.toLowerCase(),
                owner: payer.referrerId,
                active: true,
            });
            if (referralCode && await UsersSchema.exists({ _id: payer.referrerId })) {
                beneficiaryId = payer.referrerId;
                rewardTargetType = 'referrer';
            }
        }
        if (!beneficiaryId) {
            const bot = await UsersSchema.findOne({
                accounts: { $elemMatch: { type: 'twitch', name: 'domdimabot' } },
            });
            if (!bot) throw new Error('Paid order reward beneficiary not found');
            beneficiaryId = bot._id;
        }

        try {
            reservation = await CreditTransactionSchema.findOneAndUpdate(
                { idempotencyKey },
                { $setOnInsert: {
                    idempotencyKey,
                    user: beneficiaryId,
                    type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD,
                    amount,
                    metadata: {
                        referralCodeUsed: payer.referralCodeUsed,
                        referredUserId: payer._id,
                        subscriptionId: orderId,
                        planId: productId,
                        description: `Subscription reward for ${planType} (${cadence})`,
                        externalReference: idempotencyKey,
                        rewardTargetType,
                    },
                } },
                { upsert: true, new: true, writeConcern: { w: 1, j: true } },
            );
        } catch (error) {
            if ((error as { code?: number })?.code !== 11000) throw error;
            reservation = await CreditTransactionSchema.findOne({ idempotencyKey });
        }
    }

    if (!reservation) throw new Error('Paid order reward reservation not found');
    if (reservation.appliedAt) return;

    // Keep these receipts permanently: the increment and receipt are one atomic
    // user write, making retries safe even when its successful response is lost.
    const creditedUser = await UsersSchema.findOneAndUpdate(
        { _id: reservation.user, applied_credit_transaction_ids: { $ne: reservation._id } },
        {
            $inc: { token_balance: reservation.amount },
            $addToSet: { applied_credit_transaction_ids: reservation._id },
        },
        { new: true, writeConcern: { w: 1, j: true } },
    );
    if (!creditedUser && !await UsersSchema.exists({
        _id: reservation.user,
        applied_credit_transaction_ids: reservation._id,
    })) {
        throw new Error('Paid order reward reserved beneficiary not found');
    }

    // A replay cannot reconstruct the historical post-credit balance. Leave the
    // default null rather than using the beneficiary's current balance.
    await CreditTransactionSchema.updateOne(
        { _id: reservation._id, appliedAt: { $exists: false } },
        { $set: {
            appliedAt: new Date(),
            ...(creditedUser ? { balanceAfter: creditedUser.token_balance } : {}),
        } },
        { writeConcern: { w: 1, j: true } },
    );
}
