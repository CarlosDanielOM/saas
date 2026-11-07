import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertFromEventsub, seSessionEntry } from './session.js';

const viewer = { user_id: '1', user_login: 'ada', user_name: 'Ada' };
test('EventSub alerts become Dima alerts', () => {
  assert.equal(alertFromEventsub('channel.follow', viewer, 'a', 5)?.type, 'follow');
  assert.equal(alertFromEventsub('channel.subscribe', { ...viewer, tier: '2000', is_gift: true }, 'b', 5), null, 'gifted recipients come as the gift alert');
  assert.deepEqual(alertFromEventsub('channel.subscribe', { ...viewer, tier: '2000' }, 'b', 5), { id: 'b', type: 'sub', at: 5, test: false, user: { id: '1', login: 'ada', name: 'Ada' }, amount: 1, tier: '2000', months: 1, streak: null, message: null, recipient: null, currency: null, rule: null });
  const resub = alertFromEventsub('channel.subscription.message', { ...viewer, tier: '1000', cumulative_months: 14, streak_months: 3, message: { text: 'hi' } }, 'c', 5)!;
  assert.deepEqual([resub.type, resub.amount, resub.months, resub.streak, resub.message], ['resub', 14, 14, 3, 'hi']);
  const gift = alertFromEventsub('channel.subscription.gift', { ...viewer, total: 5, tier: '1000', is_anonymous: true }, 'd', 5)!;
  assert.deepEqual([gift.type, gift.amount, gift.user], ['gift', 5, null]);
  const bits = alertFromEventsub('channel.bits.use', { ...viewer, bits: 500, message: { text: 'Cheer500 go' } }, 'e', 5, false, { id: 'r', name: 'Big' })!;
  assert.deepEqual([bits.type, bits.amount, bits.message, bits.rule], ['bits', 500, 'Cheer500 go', { id: 'r', name: 'Big' }]);
  assert.equal(alertFromEventsub('channel.cheer', { ...viewer, bits: 50, message: 'Cheer50' }, 'f', 5)?.message, 'Cheer50');
  const raid = alertFromEventsub('channel.raid', { from_broadcaster_user_id: '9', from_broadcaster_user_login: 'sakura', from_broadcaster_user_name: 'Sakura', viewers: 42 }, 'g', 5)!;
  assert.deepEqual([raid.type, raid.user?.name, raid.amount], ['raid', 'Sakura', 42]);
  assert.equal(alertFromEventsub('stream.online', {}, 'h', 5), null);
  assert.deepEqual(seSessionEntry(raid), { type: 'raid', name: 'Sakura', amount: 42, message: '', createdAt: new Date(5).toISOString(), _id: 'g' });
});

test('StreamElements "*-goal" values follow the Goals page: first active goal per metric, else the first reached one', async () => {
  const { seGoals } = await import('./session.js');
  const goal = (id: string, metric: string, status: string, current: number) => ({ id, name: 'Goal ' + id, metric, status, current });
  const { data, sources } = seGoals([goal('a', 'follows', 'ended', 50), goal('b', 'follows', 'reached', 120), goal('c', 'follows', 'active', 30),
    goal('d', 'subs', 'reached', 9), goal('e', 'bits', 'scheduled', 0), goal('f', 'currency', 'active', 12_550)]);
  assert.deepEqual(data, { 'follower-goal': { amount: 30 }, 'subscriber-goal': { amount: 9 }, 'tip-goal': { amount: 125.5 } });
  assert.deepEqual(Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.id])), { 'follower-goal': 'c', 'subscriber-goal': 'd', 'tip-goal': 'f' });
  assert.deepEqual(seGoals([]), { data: {}, sources: {} });
});

test('Dima.state("goals") lists our goals then Twitch goals, each with its source and no actions', async () => {
  const { publicGoals } = await import('./state.js');
  const own = { id: 'o', name: 'Ours', metric: 'subs', mode: 'total', target: 10, current: 4, percent: 40, status: 'active', startsAt: 1, actions: { completion: { type: 'ast', text: 'secret' } } };
  const twitch = { id: 't', type: 'new_cheerer', description: '', current: 3, target: 10, percent: 30, status: 'active', achieved: null, startedAt: 2, endedAt: null,
    outcome: { phase: 'completed', sequence: 1, at: 1, actionStatus: 'finished' } };
  const list = publicGoals({ goals: [own], twitch: { goals: [twitch], rules: [{ type: 'new_cheerer', completion: { type: 'ast', text: 'secret', armedAt: 1 } }] } } as never);
  assert.deepEqual(list.map(goal => [goal.source, goal.id, goal.metric]), [['dima', 'o', 'subs'], ['twitch', 't', 'cheerers']]);
  assert.equal(list[1].name, 'Cheerer goal');
  assert.equal(JSON.stringify(list).includes('secret') || JSON.stringify(list).includes('outcome'), false);
});
