import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import UsersSchema from '../schemas/users.schema.js';
import {
    CreditTransactionSchema,
    TRANSACTION_TYPES,
    type ICreditTransaction,
} from '../schemas/credit_transaction.schema.js';
import { ReferralCodeSchema } from '../schemas/referral_code.schema.js';
import { PRODUCT_IDS, type SubscriptionCadence } from './referral.js';
import { applyPaidOrderReward } from './paid_order_reward.js';

type TestUser = {
    _id: Types.ObjectId;
    accounts: { type: string; name: string }[];
    token_balance: number;
    applied_credit_transaction_ids: Types.ObjectId[];
    referrerId?: Types.ObjectId;
    referralCodeUsed?: string;
};
type Reservation = Omit<ICreditTransaction, 'createdAt' | 'updatedAt' | 'balanceAfter'> & {
    balanceAfter: number | null;
};

function fixture(t: TestContext) {
    const owner: TestUser = {
        _id: new Types.ObjectId(), accounts: [], token_balance: 0, applied_credit_transaction_ids: [],
    };
    const bot: TestUser = {
        _id: new Types.ObjectId(), accounts: [{ type: 'twitch', name: 'domdimabot' }],
        token_balance: 10, applied_credit_transaction_ids: [],
    };
    const referrer: TestUser = {
        _id: new Types.ObjectId(), accounts: [], token_balance: 20, applied_credit_transaction_ids: [],
    };
    const state = {
        owner, bot, referrer,
        users: new Map([owner, bot, referrer].map(user => [user._id.toString(), user])),
        reservations: new Map<string, Reservation>(),
        legacy: [] as { type: string; metadata: { subscriptionId: string } }[],
        referralActive: false,
        initialized: false,
        failInit: false,
        failCredit: false,
        loseCreditResponse: false,
        failCompletion: false,
        loseCompletionResponse: false,
        loseReservationResponse: false,
        duplicateReservation: false,
    };
    const calls = {
        init: t.mock.method(CreditTransactionSchema, 'init', async () => {
            if (state.failInit) throw new Error('Index unavailable');
            state.initialized = true;
        }),
        findReservation: t.mock.method(CreditTransactionSchema, 'findOne', async (filter: any) => {
            assert.equal(state.initialized, true);
            return state.reservations.get(filter.idempotencyKey) ?? null;
        }),
        legacy: t.mock.method(CreditTransactionSchema, 'exists', async (filter: any) => {
            assert.equal(filter.type, TRANSACTION_TYPES.SUBSCRIPTION_REWARD);
            const record = [...state.legacy, ...state.reservations.values()].find(row =>
                row.type === filter.type && row.metadata.subscriptionId === filter['metadata.subscriptionId']
                && (!('idempotencyKey' in row) || row.idempotencyKey !== filter.idempotencyKey.$ne));
            return record ? { _id: new Types.ObjectId() } : null;
        }),
        owner: t.mock.method(UsersSchema, 'findById', async (id: string) => state.users.get(id) ?? null),
        bot: t.mock.method(UsersSchema, 'findOne', async (filter: any) => {
            assert.deepEqual(filter, { accounts: { $elemMatch: { type: 'twitch', name: 'domdimabot' } } });
            return [...state.users.values()].find(user => user.accounts.some(account =>
                account.type === 'twitch' && account.name === 'domdimabot')) ?? null;
        }),
        referral: t.mock.method(ReferralCodeSchema, 'exists', async (filter: any) => {
            assert.deepEqual(filter, { code: 'campaign', owner: owner.referrerId, active: true });
            return state.referralActive ? { _id: new Types.ObjectId() } : null;
        }),
        exists: t.mock.method(UsersSchema, 'exists', async (filter: any) => {
            const user = state.users.get(filter._id.toString());
            if (!user) return null;
            if (filter.applied_credit_transaction_ids && !user.applied_credit_transaction_ids.some(id =>
                id.equals(filter.applied_credit_transaction_ids))) return null;
            return { _id: user._id };
        }),
        reserve: t.mock.method(CreditTransactionSchema, 'findOneAndUpdate', async (filter: any, update: any, options: any) => {
            assert.equal(state.initialized, true);
            assert.deepEqual(options, { upsert: true, new: true, writeConcern: { w: 1, j: true } });
            assert.deepEqual(Object.keys(update), ['$setOnInsert']);
            assert.equal(update.$setOnInsert.idempotencyKey, filter.idempotencyKey);
            if (!state.reservations.has(filter.idempotencyKey)) {
                state.reservations.set(filter.idempotencyKey, {
                    _id: new Types.ObjectId(), balanceAfter: null, ...update.$setOnInsert,
                });
            }
            if (state.duplicateReservation) {
                state.duplicateReservation = false;
                throw Object.assign(new Error('Duplicate key'), { code: 11000 });
            }
            if (state.loseReservationResponse) {
                state.loseReservationResponse = false;
                throw new Error('Reservation response lost');
            }
            return state.reservations.get(filter.idempotencyKey)!;
        }),
        credit: t.mock.method(UsersSchema, 'findOneAndUpdate', async (filter: any, update: any, options: any) => {
            assert.deepEqual(options, { new: true, writeConcern: { w: 1, j: true } });
            assert.deepEqual(Object.keys(filter).sort(), ['_id', 'applied_credit_transaction_ids']);
            assert.deepEqual(Object.keys(update).sort(), ['$addToSet', '$inc']);
            assert.deepEqual(filter.applied_credit_transaction_ids, { $ne: update.$addToSet.applied_credit_transaction_ids });
            if (state.failCredit) {
                state.failCredit = false;
                throw new Error('Credit unavailable');
            }
            const user = state.users.get(filter._id.toString());
            const receipt = update.$addToSet.applied_credit_transaction_ids;
            if (!user || user.applied_credit_transaction_ids.some(id => id.equals(receipt))) return null;
            user.token_balance += update.$inc.token_balance;
            user.applied_credit_transaction_ids.push(receipt);
            if (state.loseCreditResponse) {
                state.loseCreditResponse = false;
                throw new Error('Credit response lost');
            }
            return { ...user };
        }),
        complete: t.mock.method(CreditTransactionSchema, 'updateOne', async (filter: any, update: any, options: any) => {
            assert.deepEqual(options, { writeConcern: { w: 1, j: true } });
            if (state.failCompletion) {
                state.failCompletion = false;
                throw new Error('Ledger unavailable');
            }
            assert.deepEqual(filter.appliedAt, { $exists: false });
            const row = [...state.reservations.values()].find(row => row._id.equals(filter._id));
            assert.ok(row);
            if (row.appliedAt) return { matchedCount: 0 };
            Object.assign(row, update.$set);
            if (state.loseCompletionResponse) {
                state.loseCompletionResponse = false;
                throw new Error('Ledger response lost');
            }
            return { matchedCount: 1 };
        }),
    };
    const input = {
        ownerUserId: owner._id.toString(), orderId: 'order-1',
        productId: PRODUCT_IDS.PREMIUM, cadence: 'monthly' as SubscriptionCadence,
    };
    return { state, calls, input };
}

test('same paid order twice credits once for a canonical owner without Twitch', async t => {
    const { state, calls, input } = fixture(t);
    await applyPaidOrderReward(input);
    await applyPaidOrderReward(input);
    assert.equal(state.bot.token_balance, 60);
    assert.equal(state.bot.applied_credit_transaction_ids.length, 1);
    assert.equal(state.reservations.size, 1);
    const row = state.reservations.get('polar:paid-order:order-1')!;
    assert.equal(row.balanceAfter, 60);
    assert.ok(row.appliedAt instanceof Date);
    assert.equal(row.metadata.referredUserId, state.owner._id);
    assert.equal(row.metadata.rewardTargetType, 'bot');
    assert.equal(calls.credit.mock.callCount(), 1);
});

test('concurrent deliveries of one order share a reservation and atomic credit', async t => {
    const { state, input } = fixture(t);
    await Promise.all([applyPaidOrderReward(input), applyPaidOrderReward(input)]);
    assert.equal(state.reservations.size, 1);
    assert.equal(state.bot.token_balance, 60);
    assert.equal(state.bot.applied_credit_transaction_ids.length, 1);
});

for (const failure of ['failCompletion', 'loseCreditResponse'] as const) {
    test(`${failure}: retry completes ledger without repeating successful credit`, async t => {
        const { state, input } = fixture(t);
        state[failure] = true;
        await assert.rejects(applyPaidOrderReward(input), /Ledger unavailable|Credit response lost/);
        const row = state.reservations.get('polar:paid-order:order-1')!;
        assert.equal(state.bot.token_balance, 60);
        assert.equal(row.appliedAt, undefined);
        state.bot.token_balance += 7;
        await applyPaidOrderReward(input);
        assert.equal(state.bot.token_balance, 67);
        assert.equal(state.bot.applied_credit_transaction_ids.length, 1);
        assert.ok(row.appliedAt);
        assert.equal(row.balanceAfter, null);
    });
}

test('reservation response loss resumes frozen recipient, payer and amount despite changed settings', async t => {
    const { state, calls, input } = fixture(t);
    state.owner.referrerId = state.referrer._id;
    state.owner.referralCodeUsed = 'CAMPAIGN';
    state.referralActive = true;
    state.loseReservationResponse = true;
    await assert.rejects(applyPaidOrderReward(input), /Reservation response lost/);
    assert.equal(state.referrer.token_balance, 20);
    const row = state.reservations.get('polar:paid-order:order-1')!;
    state.referralActive = false;
    state.owner.referrerId = state.bot._id;
    state.owner.referralCodeUsed = 'changed';
    state.users.delete(state.owner._id.toString());
    await applyPaidOrderReward({ ...input, ownerUserId: '', productId: PRODUCT_IDS.FREE, cadence: 'yearly' });
    assert.equal(state.referrer.token_balance, 70);
    assert.equal(state.bot.token_balance, 10);
    assert.equal(row.amount, 50);
    assert.equal(row.metadata.referredUserId, state.owner._id);
    assert.equal(row.metadata.referralCodeUsed, 'CAMPAIGN');
    assert.equal(row.metadata.rewardTargetType, 'referrer');
    assert.equal(calls.owner.mock.callCount(), 1);
    assert.equal(calls.referral.mock.callCount(), 1);
});

test('failure before credit leaves a reservation that is applied on retry', async t => {
    const { state, input } = fixture(t);
    state.failCredit = true;
    await assert.rejects(applyPaidOrderReward(input), /Credit unavailable/);
    assert.equal(state.bot.token_balance, 10);
    assert.equal(state.reservations.size, 1);
    await applyPaidOrderReward(input);
    assert.equal(state.bot.token_balance, 60);
});

test('duplicate-key reservation race rereads the winning reservation', async t => {
    const { state, calls, input } = fixture(t);
    state.duplicateReservation = true;
    await applyPaidOrderReward(input);
    assert.equal(calls.findReservation.mock.callCount(), 2);
    assert.equal(state.bot.token_balance, 60);
    assert.equal(state.reservations.size, 1);
});

test('ledger response loss returns on retry without another credit attempt', async t => {
    const { state, calls, input } = fixture(t);
    state.loseCompletionResponse = true;
    await assert.rejects(applyPaidOrderReward(input), /Ledger response lost/);
    await applyPaidOrderReward(input);
    assert.equal(calls.credit.mock.callCount(), 1);
    assert.equal(state.bot.token_balance, 60);
});

test('different paid orders each earn a reward and retain both receipts', async t => {
    const { state, input } = fixture(t);
    await applyPaidOrderReward(input);
    await applyPaidOrderReward({ ...input, orderId: 'order-2' });
    assert.equal(state.reservations.size, 2);
    assert.equal(state.bot.token_balance, 110);
    assert.equal(state.bot.applied_credit_transaction_ids.length, 2);
});

for (const [productId, cadence, amount] of [
    [PRODUCT_IDS.PREMIUM, 'monthly', 50], [PRODUCT_IDS.PREMIUM, 'yearly', 500],
    [PRODUCT_IDS.PRO, 'monthly', 125], [PRODUCT_IDS.PRO, 'yearly', 1250],
] as const) {
    test(`preserves ${productId} ${cadence} reward amount ${amount}`, async t => {
        const { state, input } = fixture(t);
        state.owner.referrerId = state.referrer._id;
        state.owner.referralCodeUsed = 'campaign';
        state.referralActive = true;
        state.users.delete(state.bot._id.toString());
        await applyPaidOrderReward({ ...input, productId, cadence });
        assert.equal(state.referrer.token_balance, 20 + amount);
    });
}

for (const reason of ['inactive-code', 'missing-referrer'] as const) {
    test(`${reason} falls back to bot`, async t => {
        const { state, input } = fixture(t);
        state.owner.referrerId = state.referrer._id;
        state.owner.referralCodeUsed = 'campaign';
        state.referralActive = reason !== 'inactive-code';
        if (reason === 'missing-referrer') state.users.delete(state.referrer._id.toString());
        await applyPaidOrderReward(input);
        assert.equal(state.bot.token_balance, 60);
    });
}

test('missing owner and missing beneficiary fail without reservation, allowing retry', async t => {
    const { state, input } = fixture(t);
    state.users.delete(state.owner._id.toString());
    await assert.rejects(applyPaidOrderReward(input), /owner not found/);
    state.users.set(state.owner._id.toString(), state.owner);
    state.users.delete(state.bot._id.toString());
    await assert.rejects(applyPaidOrderReward(input), /beneficiary not found/);
    assert.equal(state.reservations.size, 0);
    state.users.set(state.bot._id.toString(), state.bot);
    await applyPaidOrderReward(input);
    assert.equal(state.bot.token_balance, 60);
});

test('missing reserved beneficiary throws instead of marking the ledger applied', async t => {
    const { state, input } = fixture(t);
    state.failCredit = true;
    await assert.rejects(applyPaidOrderReward(input), /Credit unavailable/);
    state.users.delete(state.bot._id.toString());
    await assert.rejects(applyPaidOrderReward(input), /reserved beneficiary not found/);
    assert.equal(state.reservations.get('polar:paid-order:order-1')!.appliedAt, undefined);
    state.users.set(state.bot._id.toString(), state.bot);
    await applyPaidOrderReward(input);
    assert.equal(state.bot.token_balance, 60);
});

test('invalid canonical identity and empty order ID fail before reservation', async t => {
    const { state, input } = fixture(t);
    await assert.rejects(applyPaidOrderReward({ ...input, ownerUserId: 'twitch-id' }), /canonical owner/);
    await assert.rejects(applyPaidOrderReward({ ...input, orderId: '' }), /order ID/);
    assert.equal(state.reservations.size, 0);
});

test('legacy order subscription reward is not credited again, even with unknown historical balance', async t => {
    const { state, calls, input } = fixture(t);
    state.legacy.push({ type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD, metadata: { subscriptionId: input.orderId } });
    await applyPaidOrderReward(input);
    assert.equal(state.reservations.size, 0);
    assert.equal(state.bot.token_balance, 10);
    assert.equal(calls.credit.mock.callCount(), 0);
});

test('subscription-update rewards and unrelated transaction types do not suppress paid-order rewards', async t => {
    const { state, input } = fixture(t);
    state.legacy.push(
        { type: TRANSACTION_TYPES.SUBSCRIPTION_REWARD, metadata: { subscriptionId: 'subscription-1' } },
        { type: TRANSACTION_TYPES.REFERRAL_BONUS, metadata: { subscriptionId: input.orderId } },
    );
    await applyPaidOrderReward(input);
    assert.equal(state.bot.token_balance, 60);
});

test('free and unknown products reserve and credit nothing', async t => {
    const { state, calls, input } = fixture(t);
    await applyPaidOrderReward({ ...input, productId: PRODUCT_IDS.FREE });
    await applyPaidOrderReward({ ...input, productId: 'unknown' });
    assert.equal(state.reservations.size, 0);
    assert.equal(calls.owner.mock.callCount(), 0);
    assert.equal(calls.credit.mock.callCount(), 0);
});

test('index initialization failure prevents reservation and credit', async t => {
    const { state, calls, input } = fixture(t);
    state.failInit = true;
    await assert.rejects(applyPaidOrderReward(input), /Index unavailable/);
    assert.equal(calls.reserve.mock.callCount(), 0);
    assert.equal(calls.credit.mock.callCount(), 0);
});

test('schema keeps permanent receipts hidden and reservation keys uniquely indexed only for strings', () => {
    const receipt = UsersSchema.schema.path('applied_credit_transaction_ids');
    assert.equal(receipt.options.select, false);
    assert.equal(receipt.options.default, undefined);
    assert.equal(receipt.instance, 'Array');
    assert.equal(new UsersSchema().applied_credit_transaction_ids, undefined);
    assert.ok(CreditTransactionSchema.schema.indexes().some(([fields, options]) =>
        fields.idempotencyKey === 1 && options.unique === true
        && JSON.stringify(options.partialFilterExpression) === JSON.stringify({ idempotencyKey: { $type: 'string' } })));
    assert.equal(new CreditTransactionSchema().appliedAt, undefined);
    assert.equal(new CreditTransactionSchema().balanceAfter, null);
});
