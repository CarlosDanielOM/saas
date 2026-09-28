import assert from 'node:assert/strict';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import UsersSchema from '/app/dist/schemas/users.schema.js';
import { CreditTransactionSchema } from '/app/dist/schemas/credit_transaction.schema.js';

assert.equal(process.env.SAAS_TARGET, 'api');
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_/);
await mongoose.connect(process.env.MONGO_URI);
const redis = await getDragonflyClient('referral-ledger-check');
const ownerId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const code = 'ledgercode';
const people = Array.from({ length: 22 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), name: `referred-${index}`,
    accounts: [], plan_tier: index === 0 ? 'premium' : 'free',
    referrerId: ownerId, referralCodeUsed: code,
    created_at: new Date(Date.UTC(2026, 8, 1 + index)),
}));

try {
    await UsersSchema.collection.insertMany([
        { _id: ownerId, name: 'ledger-owner', accounts: [{ type: 'twitch', id: 'ledger-owner', name: 'ledger-owner' }] },
        { _id: otherId, name: 'ledger-other', accounts: [{ type: 'twitch', id: 'ledger-other', name: 'ledger-other' }] },
        ...people,
    ]);
    await redis.hSet('token:ledger-test-token', {
        id: 'ledger-owner', login: 'ledger-owner', display_name: 'Ledger Owner', profile_image_url: '',
    });
    await redis.expire('token:ledger-test-token', 300);
    const reward = (person, id, amount, applied) => ({
        _id: new mongoose.Types.ObjectId(), user: ownerId, type: 'subscription_reward', amount,
        idempotencyKey: `polar:paid-order:${id}`,
        ...(applied ? { appliedAt: new Date('2026-10-01T00:00:00Z') } : {}),
        createdAt: new Date('2026-10-01T00:00:00Z'),
        metadata: { referredUserId: person._id, referralCodeUsed: code, rewardTargetType: 'referrer', subscriptionId: id },
    });
    await CreditTransactionSchema.collection.insertMany([
        reward(people[0], 'first', 50, true),
        reward(people[0], 'renewal', 50, true),
        reward(people[1], 'pending', 50, false),
        { ...reward(people[2], 'bot', 50, true), user: otherId, metadata: { referredUserId: people[2]._id, rewardTargetType: 'bot' } },
        { _id: new mongoose.Types.ObjectId(), user: ownerId, type: 'referral_bonus', amount: 100,
          createdAt: new Date('2026-10-02T00:00:00Z'), metadata: { referredUserId: people[3]._id, referralCodeUsed: code } },
    ]);

    const base = 'http://127.0.0.1:3000/referrals/ledger';
    const headers = { Authorization: 'Bearer ledger-test-token' };
    const get = async (query, authorized = true) => fetch(`${base}?${query}`, authorized ? { headers } : {});
    assert.equal((await get('channelID=ledger-owner', false)).status, 401);
    assert.equal((await get('channelID=ledger-other')).status, 403);
    assert.equal((await get('channelID=ledger-owner&page=-1')).status, 400);

    const first = await (await get('channelID=ledger-owner&view=people&page=0')).json();
    assert.equal(first.error, false);
    assert.equal(first.data.items.length, 20);
    assert.equal(first.data.hasMore, true);
    assert.equal(first.data.items[0].name, 'referred-21');
    assert.equal(first.data.items.find((item) => item.name === 'referred-3').creditsEarned, 100);
    const second = await (await get('channelID=ledger-owner&view=people&page=1')).json();
    assert.equal(second.data.items.length, 2);
    assert.equal(second.data.hasMore, false);
    assert.equal(second.data.items.find((item) => item.name === 'referred-0').creditsEarned, 100);
    assert.equal(second.data.items.find((item) => item.name === 'referred-1').creditsEarned, 0);

    const timelineFirst = await (await get('channelID=ledger-owner&view=timeline&page=0')).json();
    const timelineSecond = await (await get('channelID=ledger-owner&view=timeline&page=1')).json();
    assert.equal(timelineFirst.error, false);
    assert.equal(timelineFirst.data.items.length, 20);
    assert.equal(timelineFirst.data.hasMore, true);
    assert.equal(timelineSecond.data.items.length, 5);
    assert.equal(timelineSecond.data.hasMore, false);
    const allEvents = [...timelineFirst.data.items, ...timelineSecond.data.items];
    assert.equal(allEvents.filter((event) => event.kind === 'signup').length, 22);
    assert.equal(allEvents.filter((event) => event.kind === 'reward').length, 3);
    assert.ok(allEvents.every((event, index) => index === 0 || event.at <= allEvents[index - 1].at));
    assert.equal(allEvents.some((event) => event.kind === 'reward' && event.name === 'referred-1'), false);
    assert.equal(allEvents.some((event) => event.kind === 'reward' && event.name === 'referred-2'), false);
    console.log('Referral ledger access, pagination, people totals, and event timeline passed');
} finally {
    await mongoose.disconnect();
    await redis.quit();
}
