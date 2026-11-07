import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import Users from '../schemas/users.schema.js';
import Eventsub from '../schemas/eventsub.schema.js';
import type { DomainEventEnvelope } from '../domain_events/domain_event.types.js';
import { Types } from 'mongoose';

mock.module('../utils/databases/mongodb.database.js', { namedExports: { getMongoDBConnection: async () => undefined } });
mock.module('../widget_feed/session-refresh.js', { namedExports: { requestWidgetSessionRefresh: () => undefined } });
mock.module('./twitch-store.js', { namedExports: { readTwitchGoals: async () => null } });
const actionCalls: string[] = [];
mock.module('../utils/ast_command_delivery.js', { namedExports: { deliverAstMessage: async (_channel: string, message: any) => {
  actionCalls.push(message.parsedText); return { error: false };
} } });
const { GoalSet, GoalContribution, GoalCustomReceipt, goalSnapshot, applyGoalEvent, applyCustomGoalEvent, assertCustomGoalReceiptCompatible } = await import('./service.js');
const { settleGoalChannel } = await import('./completion.js');
const { goalMonthForKey } = await import('./monthly.js');

function setup(t: TestContext, initial: any) {
  const state = structuredClone(initial), receipts = new Map<string, any>();
  const customReceipts = new Map<string, any>();
  const path = (value: any, key: string) => key.split('.').reduce((row, part) => row?.[part], value);
  const set = (value: any, key: string, next: any) => {
    const parts = key.split('.'); let cursor = value;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
    cursor[parts.at(-1)!] = structuredClone(next);
  };
  const query = (value: () => any) => ({ select() { return this; }, sort() { return this; },
    lean: async () => structuredClone(value()) });
  let race = false, concurrentCustomInsert = false, concurrentContributionInsert = false;
  t.mock.method(Users, 'findOne', (() => query(() => ({ plan_tier: 'pro' }))) as never);
  t.mock.method(Eventsub, 'findOne', (() => query(() => null)) as never);
  t.mock.method(GoalSet, 'findById', ((channel: string) => query(() => channel === state._id ? state : null)) as never);
  t.mock.method(GoalSet, 'updateOne', (async (filter: any, update: any) => {
    if (race) { state.revision++; race = false; }
    if (filter._id !== state._id || filter.revision !== undefined && filter.revision !== state.revision) return { modifiedCount: 0 };
    if (filter['goals.id'] && !state.goals.some((goal: any) => goal.id === filter['goals.id'])) return { modifiedCount: 0 };
    for (const [key, expected] of Object.entries(filter)) {
      if (key === '_id' || key === 'revision' || key === 'goals.id') continue;
      const actual = path(state, key);
      if (expected && typeof expected === 'object' && '$exists' in expected) {
        if ((actual !== undefined) !== expected.$exists) return { modifiedCount: 0 };
      } else if (actual !== expected) return { modifiedCount: 0 };
    }
    for (const [key, value] of Object.entries(update.$set || {})) set(state, key, value);
    return { modifiedCount: 1 };
  }) as never);
  t.mock.method(GoalContribution, 'updateOne', (async (filter: any, update: any) => {
    if (!receipts.has(filter._id)) receipts.set(filter._id, structuredClone(update.$setOnInsert));
    if (concurrentContributionInsert) { concurrentContributionInsert = false; throw Object.assign(new Error('concurrent contribution insert'), { code: 11000 }); }
    return { modifiedCount: 1 };
  }) as never);
  t.mock.method(GoalContribution, 'findById', ((id: string) => query(() => receipts.get(id) ?? null)) as never);
  t.mock.method(GoalCustomReceipt, 'findOneAndUpdate', ((filter: any, update: any) => {
    const existing = customReceipts.get(filter._id);
    if (existing && existing.fingerprint !== filter.fingerprint) throw Object.assign(new Error('duplicate receipt'), { code: 11000 });
    if (!existing) customReceipts.set(filter._id, structuredClone(update.$setOnInsert));
    if (!existing && concurrentCustomInsert) { concurrentCustomInsert = false; throw Object.assign(new Error('concurrent identical insert'), { code: 11000 }); }
    return query(() => customReceipts.get(filter._id));
  }) as never);
  t.mock.method(GoalCustomReceipt, 'findById', ((id: string) => query(() => customReceipts.get(id) ?? null)) as never);
  t.mock.method(GoalContribution, 'aggregate', (async (pipeline: any[]) => {
    const f = pipeline[0].$match, bounds = f.occurredAt;
    const values = [...receipts.values()].filter(row => row.channel === f.channel && row.goal === f.goal &&
      (bounds.$gte === undefined || row.occurredAt >= bounds.$gte) && (bounds.$gt === undefined || row.occurredAt > bounds.$gt) &&
      (bounds.$lte === undefined || row.occurredAt <= bounds.$lte) && (bounds.$lt === undefined || row.occurredAt < bounds.$lt));
    return values.length ? [{ total: values.reduce((total, row) => total + row.amount, 0) }] : [];
  }) as never);
  return { state, receipts, staleOnNextWrite: () => { race = true; },
    concurrentCustomInsert: () => { concurrentCustomInsert = true; },
    concurrentContributionInsert: () => { concurrentContributionInsert = true; } };
}

function event(type: string, key: string, occurredAt: number, raw: any, channelID = 'channel'): DomainEventEnvelope {
  return { _id: new Types.ObjectId(), eventKey: key, source: 'twitch-eventsub', sourceEventId: key, type, topic: 'channel', schemaVersion: 1,
    channelID, occurredAt: new Date(occurredAt), journaledAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    payload: { event: raw }, metadata: { originalEventType: type === 'channel.bits.received' ? 'channel.bits.use' : type } };
}
function currencyGoal(overrides: any = {}) {
  const createdAt = Date.now() - 10_000;
  return { id: 'g', name: 'Support', metric: 'currency', mode: 'total', target: 25_000,
    createdAt, startsAt: createdAt, currency: { code: 'USD', bitValue: 1, subscriptionValue: 175,
      items: [{ key: 'streamloots_chest', unitAmount: 250, feeBasisPoints: 1000 }] }, ...overrides };
}

test('currency projection counts 250 bits plus three gift subs as 775 cents and deduplicates both paths', async t => {
  const goal = currencyGoal(), h = setup(t, { _id: 'channel', revision: 1, goals: [goal], outcomes: {} });
  const at = goal.createdAt + 100;
  const bits = event('channel.bits.received', 'bits', at, { bits: 250 });
  const gifts = event('channel.subscription.gifted', 'gifts', at, { total: 3 });
  await Promise.all([applyGoalEvent(bits), applyGoalEvent(bits), applyGoalEvent(gifts), applyGoalEvent(gifts)]);
  await applyGoalEvent(event('channel.subscription.received', 'individual-gift', at, { is_gift: true }));
  assert.equal((await goalSnapshot('channel')).goals[0].current, 775);
  assert.equal(h.receipts.size, 2);
  const custom = { ...event('goal.item.added', 'custom', at, {}), source: 'goals-custom', topic: 'domain',
    payload: { itemKey: 'streamloots_chest', quantity: 1 } } as DomainEventEnvelope;
  await applyCustomGoalEvent(custom); await applyCustomGoalEvent(custom);
  await assertCustomGoalReceiptCompatible('channel', 'custom', 'streamloots_chest', 1);
  await assert.rejects(assertCustomGoalReceiptCompatible('channel', 'custom', 'another_item', 1), /different item or quantity/);
  await assert.rejects(applyCustomGoalEvent({ ...custom, payload: { itemKey: 'another_item', quantity: 1 } }), /different item or quantity/);
  await assert.rejects(applyCustomGoalEvent({ ...custom, payload: { itemKey: 'streamloots_chest', quantity: 2 } }), /different item or quantity/);
  await applyCustomGoalEvent({ ...custom, eventKey: 'other', channelID: 'other' });
  assert.equal((await goalSnapshot('channel')).goals[0].current, 1000);
  assert.equal(h.receipts.size, 3);
});

test('monthly current resets at local midnight; late events stay in the old period', async t => {
  const january = goalMonthForKey('2026-01', 'America/New_York');
  const february = goalMonthForKey('2026-02', 'America/New_York');
  const goal = currencyGoal({ mode: 'monthly', timeZone: 'America/New_York', createdAt: january.startsAt + 1,
    startsAt: january.startsAt + 1 });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [goal], outcomes: {}, monthlyCursors: { g: january.key } });
  await applyGoalEvent(event('channel.bits.received', 'january', january.endsAt - 1, { bits: 250 }));
  assert.equal((await goalSnapshot('channel', january.endsAt - 1)).goals[0].current, 250);
  const after = (await goalSnapshot('channel', february.startsAt)).goals[0];
  assert.equal(after.period?.key, '2026-02');
  assert.equal(after.current, 0);
  await settleGoalChannel('channel', february.startsAt + 1);
  assert.equal(h.state.outcomes['g:2026-01'].phase, 'failed');
  assert.equal(h.state.monthlyCursors.g, '2026-02');
  await applyGoalEvent(event('channel.bits.received', 'late-january', january.endsAt - 2, { bits: 1000 }));
  await settleGoalChannel('channel', february.startsAt + 2);
  assert.equal(h.state.outcomes['g:2026-01'].phase, 'failed');
  assert.equal((await goalSnapshot('channel', february.startsAt + 2)).goals[0].current, 0);
});

test('a custom receipt replay uses its first occurrence and cannot backfill a newly created goal', async t => {
  const oldGoal = currencyGoal({ createdAt: Date.now() - 30_000, startsAt: Date.now() - 30_000 });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [oldGoal], outcomes: {} });
  const firstAt = Date.now() - 20_000;
  const first = { ...event('goal.item.added', 'stable', firstAt, {}), source: 'goals-custom', topic: 'domain',
    journaledAt: new Date(firstAt), payload: { itemKey: 'streamloots_chest', quantity: 1 } } as DomainEventEnvelope;
  await applyCustomGoalEvent(first);
  h.state.goals.push(currencyGoal({ id: 'new', createdAt: Date.now() - 10_000, startsAt: Date.now() - 10_000 }));
  await applyCustomGoalEvent({ ...first, occurredAt: new Date(), journaledAt: new Date() });
  assert.equal(h.receipts.size, 1);
  assert.deepEqual((await goalSnapshot('channel')).goals.map(goal => goal.current), [225, 0]);
});

test('one custom transaction updates each matching active goal using its own fee, never another channel', async t => {
  const goal = currencyGoal(), second = currencyGoal({ id: 'other-goal', currency: { ...goal.currency,
    items: [{ key: 'streamloots_chest', unitAmount: 250, feeBasisPoints: 2000 }] } });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [goal, second], outcomes: {} });
  const custom = { ...event('goal.item.added', 'sale', goal.startsAt + 100, {}), source: 'goals-custom', topic: 'domain',
    payload: { itemKey: 'streamloots_chest', quantity: 1 } } as DomainEventEnvelope;
  await applyCustomGoalEvent(custom); await applyCustomGoalEvent(custom);
  await applyCustomGoalEvent({ ...custom, channelID: 'another-channel' });
  assert.deepEqual((await goalSnapshot('channel')).goals.map(item => item.current), [225, 200]);
  assert.equal(h.receipts.size, 2);
});

test('concurrent identical first custom receipt insert is accepted after duplicate-key readback', async t => {
  const goal = currencyGoal(), h = setup(t, { _id: 'channel', revision: 1, goals: [goal], outcomes: {} });
  const custom = { ...event('goal.item.added', 'concurrent', goal.startsAt + 100, {}), source: 'goals-custom', topic: 'domain',
    payload: { itemKey: 'streamloots_chest', quantity: 1 } } as DomainEventEnvelope;
  h.concurrentCustomInsert();
  h.concurrentContributionInsert();
  await applyCustomGoalEvent(custom);
  assert.equal((await goalSnapshot('channel')).goals[0].current, 225);
  assert.equal(h.receipts.size, 1);
});

test('monthly action receipts are independent per period, and stale configuration cannot advance cursor', async t => {
  const jan = goalMonthForKey('2026-01', 'UTC'), feb = goalMonthForKey('2026-02', 'UTC');
  const goal = currencyGoal({ mode: 'monthly', timeZone: 'UTC', target: 100, createdAt: jan.startsAt, startsAt: jan.startsAt });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [goal], monthlyCursors: { g: jan.key },
    outcomes: { 'g:2026-01': { phase: 'completed', sequence: 1, at: jan.endsAt - 1, actionStatus: 'running' } } });
  await applyGoalEvent(event('channel.bits.received', 'feb', feb.startsAt + 100, { bits: 100 }));
  h.staleOnNextWrite();
  await settleGoalChannel('channel', feb.startsAt + 101);
  assert.equal(h.state.monthlyCursors.g, '2026-01');
  assert.equal(Boolean(h.state.outcomes['g:2026-02']), false);
  await settleGoalChannel('channel', feb.startsAt + 102);
  assert.equal(h.state.monthlyCursors.g, '2026-02');
  assert.equal(h.state.outcomes['g:2026-01'].actionStatus, 'running');
  assert.equal(h.state.outcomes['g:2026-02'].phase, 'completed');
  await settleGoalChannel('channel', feb.startsAt + 103);
  assert.equal(h.state.outcomes['g:2026-02'].sequence, 1);
});

test('restart catch-up records old failures without a burst and runs only the previous-month action', async t => {
  actionCalls.length = 0;
  const jan = goalMonthForKey('2026-01', 'UTC'), march = goalMonthForKey('2026-03', 'UTC');
  const goal = currencyGoal({ mode: 'monthly', timeZone: 'UTC', createdAt: jan.startsAt, startsAt: jan.startsAt,
    actions: { failure: { type: 'message', text: 'missed' } } });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [goal], monthlyCursors: { g: jan.key }, outcomes: {} });
  await settleGoalChannel('channel', march.startsAt + 1);
  assert.equal(h.state.monthlyCursors.g, '2026-02');
  assert.equal(h.state.outcomes['g:2026-01'].actionSuppressed, 'historical_catchup');
  assert.deepEqual(actionCalls, []);
  await settleGoalChannel('channel', march.startsAt + 2);
  assert.equal(h.state.monthlyCursors.g, '2026-03');
  assert.equal(h.state.outcomes['g:2026-02'].actionStatus, 'finished');
  assert.deepEqual(actionCalls, ['missed']);
  await settleGoalChannel('channel', march.startsAt + 3);
  assert.deepEqual(actionCalls, ['missed']);
});

test('monthly completion action runs once per reached month and a prior unknown result does not block the next', async t => {
  actionCalls.length = 0;
  const jan = goalMonthForKey('2026-01', 'UTC'), feb = goalMonthForKey('2026-02', 'UTC');
  const goal = currencyGoal({ mode: 'monthly', timeZone: 'UTC', target: 100, createdAt: jan.startsAt, startsAt: jan.startsAt,
    actions: { completion: { type: 'message', text: 'reached' } } });
  const h = setup(t, { _id: 'channel', revision: 1, goals: [goal], monthlyCursors: { g: jan.key }, outcomes: {} });
  await applyGoalEvent(event('channel.bits.received', 'jan-bits', jan.startsAt + 100, { bits: 100 }));
  await Promise.all([settleGoalChannel('channel', jan.startsAt + 101), settleGoalChannel('channel', jan.startsAt + 101)]);
  assert.deepEqual(actionCalls, ['reached']);
  h.state.outcomes['g:2026-01'].actionStatus = 'unknown';
  await applyGoalEvent(event('channel.bits.received', 'feb-bits', feb.startsAt + 100, { bits: 100 }));
  await settleGoalChannel('channel', feb.startsAt + 101);
  assert.deepEqual(actionCalls, ['reached', 'reached']);
  assert.equal(h.state.outcomes['g:2026-01'].actionStatus, 'unknown');
  assert.equal(h.state.outcomes['g:2026-02'].actionStatus, 'finished');
});
