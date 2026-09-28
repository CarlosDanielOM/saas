import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import UsersSchema from '../schemas/users.schema.js';
import { ReferralCodeSchema } from '../schemas/referral_code.schema.js';
import { CreditTransactionSchema, TRANSACTION_TYPES } from '../schemas/credit_transaction.schema.js';
import { getReferralStats } from './referral.js';

test('referral stats separate attributed signups from one paid conversion per referred account', async t => {
    const ownerId = new Types.ObjectId();
    const code = {
        _id: new Types.ObjectId(), owner: ownerId, code: 'ryutsuuki', active: true,
        label: '', stats: { conversions: 0 }, createdAt: new Date(), updatedAt: new Date(),
    };
    t.mock.method(UsersSchema, 'findById', async () => ({
        _id: ownerId, plan_tier: 'free', token_balance: 100,
    }));
    t.mock.method(ReferralCodeSchema, 'find', () => ({
        sort: () => ({ lean: async () => [code] }),
    }));
    const signupAggregate = t.mock.method(UsersSchema, 'aggregate', async (pipeline: any[]) => {
        assert.deepEqual(pipeline[0].$match, {
            referrerId: ownerId, referralCodeUsed: { $in: ['ryutsuuki'] },
        });
        return [{ _id: 'ryutsuuki', total: 2 }];
    });
    const rewardAggregate = t.mock.method(CreditTransactionSchema, 'aggregate', async (pipeline: any[]) => {
        if (pipeline.some(stage => stage.$group?._id?.referredUserId)) {
            assert.equal(pipeline[0].$match.user, ownerId);
            assert.deepEqual(pipeline[1].$group._id, {
                code: '$metadata.referralCodeUsed', referredUserId: '$metadata.referredUserId',
            });
            return [{ _id: 'ryutsuuki', total: 1 }];
        }
        assert.equal(pipeline[0].$match.user, ownerId);
        assert.ok(pipeline[0].$match.$or.some((clause: any) => clause.type === TRANSACTION_TYPES.SUBSCRIPTION_REWARD));
        return [{ total: 100 }];
    });

    const stats = await getReferralStats(ownerId);
    assert.equal(signupAggregate.mock.callCount(), 1);
    assert.equal(rewardAggregate.mock.callCount(), 2);
    assert.equal(stats.totalSignups, 2);
    assert.equal(stats.totalConversions, 1);
    assert.equal(stats.totalEarned, 100);
    assert.equal(stats.codes[0].stats.signups, 2);
    assert.equal(stats.codes[0].stats.conversions, 1);
});
