import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';

mock.module('../utils/databases/mongodb.database.js', { namedExports: { getMongoDBConnection: async () => undefined } });
let refreshes: string[] = [];
mock.module('../widget_feed/session-refresh.js', { namedExports: { requestWidgetSessionRefresh: (channel: string) => { refreshes.push(channel); } } });
let headerOk = true;
mock.module('../utils/header.js', { namedExports: { getTwitchStreamerHeaderById: async () => headerOk
  ? { error: false, header: { 'Client-Id': 'x', Authorization: 'Bearer y' } } : { error: true, message: 'no token' } } });
const subscribed: string[] = [];
let existingSubs: string[] = [];
mock.module('../schemas/eventsub.schema.js', { defaultExport: { find: () => ({ select: () => ({ lean: async () => existingSubs.map(type => ({ type })) }) }) } });
mock.module('../utils/eventsub.js', { namedExports: { subscribeTwitchEvent: async (channel: string, type: string, version: string, condition: { broadcaster_user_id: string }) => {
  assert.deepEqual([version, condition], ['1', { broadcaster_user_id: channel }]); subscribed.push(`${channel}:${type}`); return { id: 'x' };
} } });
const { LiveState } = await import('../overlays/interactions.js');
const { applyTwitchGoalEvent, ensureTwitchGoalSubscriptions, readTwitchGoals, resyncTwitchGoals, resyncTwitchGoalsWithin } = await import('./twitch-store.js');

function store(t: TestContext) {
  const docs = new Map<string, { _id: string; revision: number; state: unknown }>();
  const query = (value: () => unknown) => ({ lean: async () => structuredClone(value()) });
  t.mock.method(LiveState, 'findById', ((id: string) => query(() => docs.get(id) ?? null)) as never);
  t.mock.method(LiveState, 'create', (async (doc: any) => { if (docs.has(doc._id)) throw Object.assign(new Error('dup'), { code: 11000 }); docs.set(doc._id, structuredClone(doc)); }) as never);
  t.mock.method(LiveState, 'updateOne', (async (filter: any, update: any) => {
    const doc = docs.get(filter._id);
    if (!doc || doc.revision !== filter.revision) return { modifiedCount: 0 };
    docs.set(filter._id, { ...doc, ...structuredClone(update.$set) }); return { modifiedCount: 1 };
  }) as never);
  refreshes = []; headerOk = true;
  return docs;
}
const helixRow = (current: number, id = 'g1') => ({ id, broadcaster_id: '1', type: 'follower', description: '', current_amount: current, target_amount: 500, created_at: '2026-11-07T10:00:00Z' });
function twitchAnswers(t: TestContext, ...answers: (number | unknown[])[]) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (async (url: string) => {
    calls.push(String(url));
    const answer = answers.shift() ?? [];
    return typeof answer === 'number' ? new Response('{}', { status: answer }) : new Response(JSON.stringify({ data: answer }), { status: 200 });
  }) as never);
  return calls;
}

test('recovery stores Twitch goals and refreshes widgets only when something visible changed', async t => {
  store(t);
  const calls = twitchAnswers(t, [helixRow(420)]);
  await resyncTwitchGoals('100');
  assert.match(calls[0], /\/goals\?broadcaster_id=100$/);
  const stored = await readTwitchGoals('100');
  assert.deepEqual([stored?.access, stored?.goals[0].current, stored?.goals[0].type], ['ok', 420, 'follow']);
  assert.deepEqual(refreshes, ['100']);
  // Coalesced for a minute; the Goals page may ask again after 10 s.
  await resyncTwitchGoals('100');
  assert.equal(calls.length, 1);
});

test('missing permission is recorded and backed off; a missing token changes nothing', async t => {
  store(t);
  const calls = twitchAnswers(t, 401);
  await resyncTwitchGoals('200');
  assert.equal((await readTwitchGoals('200'))?.access, 'permission');
  headerOk = false;
  await resyncTwitchGoals('300');
  assert.equal(await readTwitchGoals('300'), null);
  assert.equal(calls.length, 1);
  headerOk = true;
  await assert.rejects(async () => { twitchAnswers(t, 500); await resyncTwitchGoals('400'); }, /recovery failed: 500/);
  assert.equal(await readTwitchGoals('400'), null, 'a failed request changes nothing');
});

test('an EventSub update saved during the Helix request wins (revision fence)', async t => {
  const docs = store(t);
  await applyTwitchGoalEvent('500', 'channel.goal.progress', { id: 'g1', type: 'follow', description: '', current_amount: 430, target_amount: 500, started_at: '2026-11-07T10:00:00Z' },
    new Date().toISOString(), 'r1');
  t.mock.method(globalThis, 'fetch', (async () => {
    const doc = docs.get('500:twitchgoals')!; docs.set('500:twitchgoals', { ...doc, revision: doc.revision + 1 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as never);
  await resyncTwitchGoals('500');
  const stored = await readTwitchGoals('500');
  assert.equal(stored?.goals[0].phase, 'active', 'the stale empty answer was dropped');
  assert.equal(stored?.checkedAt, null);
});

test('events: duplicates do nothing; the page waits at most the given time', async t => {
  store(t);
  const raw = { id: 'g1', type: 'new_bit', description: 'Bits!', current_amount: 100, target_amount: 1000, started_at: '2026-11-07T10:00:00Z' };
  await applyTwitchGoalEvent('600', 'channel.goal.begin', raw, '2026-11-07T10:00:01Z', 'r1');
  await applyTwitchGoalEvent('600', 'channel.goal.begin', raw, '2026-11-07T10:00:01Z', 'r1');
  assert.deepEqual(refreshes, ['600']);
  await assert.rejects(applyTwitchGoalEvent('600', 'channel.goal.progress', { ...raw, type: 'donations' }, '2026-11-07T10:00:02Z', 'r2'), /Unknown Twitch goal type/);
  t.mock.method(globalThis, 'fetch', (() => new Promise(() => {})) as never);
  const started = Date.now();
  await resyncTwitchGoalsWithin('700', 50, { fromPage: true });
  assert.ok(Date.now() - started < 1000);
});

test('a channel Twitch lets us read gets its missing goal notifications once; denied channels get none', async t => {
  store(t);
  subscribed.length = 0; existingSubs = ['channel.goal.progress'];
  twitchAnswers(t, [helixRow(10)]);
  await resyncTwitchGoals('800');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(subscribed, ['800:channel.goal.begin', '800:channel.goal.end']);
  await ensureTwitchGoalSubscriptions('800');
  assert.equal(subscribed.length, 2, 'checked at most once an hour');
  twitchAnswers(t, 403);
  await resyncTwitchGoals('801');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(subscribed.some(entry => entry.startsWith('801:')), false);
});
