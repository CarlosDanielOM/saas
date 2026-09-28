import assert from 'node:assert/strict';
import mongoose from '/app/node_modules/mongoose/index.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { ReferralCodeSchema } from '/app/dist/schemas/referral_code.schema.js';
import { CreditTransactionSchema } from '/app/dist/schemas/credit_transaction.schema.js';
import { PRODUCT_IDS, getReferralStats } from '/app/dist/utils/referral.js';
import { normalizePolarDomainEvent } from '/app/dist/domain_events/polar_events.js';
import { applyPolarRewardDomainEvent } from '/app/dist/domain_events/polar_billing_events.js';

assert.ok(['api', 'cron'].includes(process.env.SAAS_TARGET));
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_/);
await mongoose.connect(process.env.MONGO_URI);

const referrerId = new mongoose.Types.ObjectId();
const payerId = new mongoose.Types.ObjectId();
const code = 'referral_check';
const subscriptionId = 'subscription-check';
const subscription = {
    id: subscriptionId, recurringInterval: 'month',
    currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
};

function order(id, totalAmount, withSubscription = true) {
    const event = normalizePolarDomainEvent({
        webhookId: `receipt-${id}`,
        event: {
            type: 'order.paid', timestamp: new Date(),
            data: {
                id, customerId: 'customer-check', productId: PRODUCT_IDS.PREMIUM,
                status: 'paid', paid: true, totalAmount,
                subscriptionId: withSubscription ? subscriptionId : null,
                subscription: withSubscription ? subscription : null,
            },
        },
    });
    return { ...event, ownerUserId: payerId.toString() };
}

try {
    await UsersSchema.collection.insertMany([
        { _id: referrerId, name: 'referrer-check', plan_tier: 'free', token_balance: 0, accounts: [] },
        {
            _id: payerId, name: 'payer-check', plan_tier: 'premium', token_balance: 0,
            referrerId, referralCodeUsed: code, accounts: [],
        },
    ]);
    await ReferralCodeSchema.collection.insertOne({
        _id: new mongoose.Types.ObjectId(), owner: referrerId, code, label: '', active: true,
        stats: { conversions: 0 }, createdAt: new Date(), updatedAt: new Date(),
    });

    const getOwner = async () => await UsersSchema.findById(payerId);
    await applyPolarRewardDomainEvent(order('trial', 0), { getOwner });
    await applyPolarRewardDomainEvent(order('credit-pack', 600, false), { getOwner });
    assert.equal(await CreditTransactionSchema.countDocuments({}), 0);
    assert.equal((await getReferralStats(referrerId)).totalConversions, 0);

    const purchase = order('paid-subscription', 600);
    await applyPolarRewardDomainEvent(purchase, { getOwner });
    await applyPolarRewardDomainEvent(purchase, { getOwner });
    let stats = await getReferralStats(referrerId);
    assert.equal(stats.totalSignups, 1);
    assert.equal(stats.totalConversions, 1);
    assert.equal(stats.totalEarned, 50);
    assert.equal((await UsersSchema.findById(referrerId)).token_balance, 50);

    await applyPolarRewardDomainEvent(order('renewal', 600), { getOwner });
    stats = await getReferralStats(referrerId);
    assert.equal(stats.totalConversions, 1);
    assert.equal(stats.totalEarned, 100);
    assert.equal((await UsersSchema.findById(referrerId)).token_balance, 100);
    console.log('Trial, one-time, paid subscription, duplicate, and renewal referral checks passed');
} finally {
    await mongoose.disconnect();
}
