import assert from 'node:assert/strict';
import mongoose from '/app/node_modules/mongoose/index.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { ReferralCodeSchema } from '/app/dist/schemas/referral_code.schema.js';
import { CreditTransactionSchema, TRANSACTION_TYPES } from '/app/dist/schemas/credit_transaction.schema.js';
import { getReferralStats, PRODUCT_IDS } from '/app/dist/utils/referral.js';

assert.equal(process.env.SAAS_TARGET, 'api');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_/);
const { Types } = mongoose;
await mongoose.connect(process.env.MONGO_URI);

const owner = new Types.ObjectId();
const firstSignup = new Types.ObjectId();
const secondSignup = new Types.ObjectId();
const code = 'test_referral';

try {
    await UsersSchema.collection.insertMany([
        { _id: owner, name: 'test-referrer', plan_tier: 'free', token_balance: 100, accounts: [] },
        { _id: firstSignup, name: 'first-signup', plan_tier: 'premium', referrerId: owner, referralCodeUsed: code, accounts: [] },
        { _id: secondSignup, name: 'second-signup', plan_tier: 'free', referrerId: owner, referralCodeUsed: code, accounts: [] },
    ]);
    await ReferralCodeSchema.collection.insertOne({
        _id: new Types.ObjectId(), owner, code, label: '', active: true,
        stats: { conversions: 0 }, createdAt: new Date(), updatedAt: new Date(),
    });

    const beforePurchase = await getReferralStats(owner);
    assert.equal(beforePurchase.totalSignups, 2);
    assert.equal(beforePurchase.totalConversions, 0);
    assert.equal(beforePurchase.codes[0].stats.signups, 2);
    assert.equal(beforePurchase.codes[0].stats.conversions, 0);

    const reward = (orderId, applied) => ({
        _id: new Types.ObjectId(), user: owner, type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD,
        amount: 50, idempotencyKey: `polar:paid-order:${orderId}`,
        ...(applied ? { appliedAt: new Date() } : {}),
        metadata: {
            referralCodeUsed: code, referredUserId: firstSignup, subscriptionId: orderId,
            planId: PRODUCT_IDS.PREMIUM, rewardTargetType: 'referrer',
        },
    });
    await CreditTransactionSchema.collection.insertMany([
        reward('first-purchase', true), reward('renewal', true), reward('pending-order', false),
    ]);

    const afterRenewal = await getReferralStats(owner);
    assert.equal(afterRenewal.totalSignups, 2);
    assert.equal(afterRenewal.totalConversions, 1);
    assert.equal(afterRenewal.codes[0].stats.conversions, 1);
    assert.equal(afterRenewal.totalEarned, 100);

    const validation = await fetch(`http://127.0.0.1:3000/referrals/validate/${code}`);
    assert.equal(validation.status, 200);
    assert.equal((await validation.json()).data.valid, true);
    console.log('Referral signup, first purchase, renewal, pending order, and code validation checks passed');
} finally {
    await mongoose.disconnect();
}
