// saas-ops only (api target): disposable Mongo/Redis, fake S3 + fake StreamElements CDN.
// Stage into --fixtures: custom-widget-fixtures/{providers.mjs,sample-chat,dima-chat} and
// overlay-fixtures/providers.mjs as base-providers.mjs. Test env: custom-widget-fixtures/test-env.json.
// Covers the widget engine's server side: widget.json, owner/public bundles, the overlay-feed socket
// (session, journal alerts, chat and command signals from the bot's pub/sub, storage events, Studio tests), widget RPC
// (store, counters, limits, manifest permissions), chat demand, media copying and copied-asset serving, and
// StreamElements totals/month/"manual" goals in session data (ledgers, journal, Goals page) with goal refreshes,
// live state (polls, goals, hypetrain, ads) and bot events (rewards, triggers, pets, duels, roulette) for widgets that use
// them (fake Helix hype train status / ad schedule via helix-*.json, see providers.mjs), Studio's state/chat-history routes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const preview = '533538623', parts = ['html', 'css', 'js', 'fields', 'data'];
const read = async name => Object.fromEntries(await Promise.all(parts.map(async part => [part, await readFile(`/tmp/saas-fixtures/${name}/${part}.txt`, 'utf8')])));
const sample = await read('sample-chat'), dima = { ...await read('dima-chat'), manifest: await readFile('/tmp/saas-fixtures/dima-chat/widget.json', 'utf8') };

const objects = new Map();
const s3 = createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
    const key = decodeURIComponent(new URL(req.url, 'http://s3').pathname).replace(/^\/fixture-bucket\//, '');
    if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.setHeader('ETag', '"f"'); return res.end(); }
    if (req.method === 'GET') { const body = objects.get(key); if (!body) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); } res.setHeader('Content-Length', body.length); return res.end(body); }
    objects.delete(key); res.statusCode = 204; res.end();
  });
});
await new Promise(resolve => s3.listen(9311, '127.0.0.1', resolve));

const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js'); await getMongoDBConnection('custom-widget-engine-test');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js'); const redis = await getDragonflyClient('custom-widget-engine-test');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { DomainEventSchema } = await import('/app/dist/schemas/domain_event.schema.js');
const { CommandsSchema } = await import('/app/dist/schemas/commands.schema.js');
const { encrypt } = await import('/app/dist/utils/crypto.js');
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: preview, name: 'CDom201', has_permissions: true, up_to_date_permissions: true, actived: true, chat_enabled: false,
  access_token: encrypt('fixture'), refresh_token: encrypt('fixture-refresh'), access_token_expires_at: Math.floor(Date.now() / 1000) + 3600 }], plan_tier: 'premium' });
await redis.hSet('token:cwe-' + preview, { id: preview, login: 'cdom201', display_name: 'CDom201' });
await CommandsSchema.collection.insertOne({ channelID: preview, cmd: 'deaths', count: 7, activation: 'command' });
// A Twitch account (fake token) for Helix reads; fake hype train status / ad schedule replies come from files (providers.mjs).
await redis.hSet(`accounts:twitch:${preview}:data`, { id: preview, name: 'cdom201', has_permissions: 'true', access_token: 'fixture', expires_at: String(Math.floor(Date.now() / 1000) + 3600), userPlan: 'premium' });
const { writeFileSync, readFileSync } = await import('node:fs');
const helix = (name, reply) => writeFileSync(`/tmp/saas-fixtures/helix-${name}.json`, JSON.stringify(reply));
const helixCalls = name => { try { return readFileSync('/tmp/saas-fixtures/helix-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => call.name === name).length; } catch { return 0; } };
const nextAdAt = Date.now() + 20 * 60_000;
helix('ads', { body: { data: [{ next_ad_at: new Date(nextAdAt).toISOString(), last_ad_at: '', duration: '90', preroll_free_time: 0, snooze_count: 3, snooze_refresh_at: new Date(Date.now() + 3_600_000).toISOString() }] } });
helix('hypetrain', { body: { data: [{ current: null, all_time_high: null, shared_all_time_high: null }] } });

async function req(method, path, body, status = 200) {
  const response = await fetch('http://127.0.0.1:3000' + path, { method, headers: { Authorization: 'Bearer cwe-' + preview, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const data = async (...args) => (await req(...args)).data;
const base = '/overlay-studio/' + preview, widgetsPath = base + '/custom-widgets';
const until = async (fn, label, tries = 160) => { for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out: ' + label); };

try {
  // widget.json import + bundles.
  const native = (await data('POST', widgetsPath, { files: dima }, 201)).widget;
  assert.deepEqual([native.name, native.manifest.engine, native.manifest.uses], ['Dima sample chat', 'dima', ['chat', 'alerts', 'storage', 'counters', 'session']]);
  const seWidget = (await data('POST', widgetsPath, { files: sample }, 201)).widget;
  const twin = (await data('POST', widgetsPath, { name: 'Second Dima widget', files: dima }, 201)).widget;
  assert.deepEqual([seWidget.manifest.engine, seWidget.manifest.uses, seWidget.manifest.inferred], ['streamelements', ['chat', 'alerts'], true]);
  assert.match((await req('POST', widgetsPath, { files: { ...dima, manifest: '{"api":9}' } }, 400)).message, /newer widget engine/);
  const petSignals = [{ name: 'feed', description: 'Feed the pet', values: ['pizza'] }];
  const pet = (await data('POST', widgetsPath, { name: 'Pet', files: { ...dima, manifest: JSON.stringify({ engine: 'dima', api: 1, name: 'Pet', uses: ['signals', 'polls', 'goals', 'tts', 'triggers', 'rewards', 'pets', 'duels', 'roulette', 'dimafx', 'hypetrain', 'ads'], signals: [...petSignals, { name: 'Bad.Name' }] }) } }, 201)).widget;
  assert.deepEqual([pet.manifest.uses, pet.manifest.signals], [['signals', 'polls', 'goals', 'tts', 'triggers', 'rewards', 'pets', 'duels', 'roulette', 'dimafx', 'hypetrain', 'ads'], petSignals], 'declared signals are kept; invalid declarations are skipped');
  const ownerBundle = await data('GET', `${widgetsPath}/${native.id}/bundle`);
  assert.deepEqual([ownerBundle.engine, ownerBundle.js, ownerBundle.revision, ownerBundle.channel], ['dima', dima.js, 1, { id: preview, login: 'cdom201', name: 'CDom201' }]);
  assert.equal(await (await fetch(`http://127.0.0.1:3000${widgetsPath}/${native.id}/files/manifest`, { headers: { Authorization: 'Bearer cwe-' + preview } })).text(), dima.manifest);

  // Publish both widgets in one overlay.
  let state = await data('GET', base);
  const layer = (id, widgetId, name) => ({ id, kind: 'custom', configVersion: 1, x: 0, y: 0, width: 480, height: 640, visible: true, locked: false, config: { widgetId }, ...(name ? { name } : {}) });
  state.scenes[0].widgets = [layer('dima-layer', native.id), layer('se-layer', seWidget.id), layer('twin-layer', twin.id), layer('pet-layer', pet.id, 'Pet corner'), layer('pet2-layer', pet.id, 'Chat box')];
  state = await data('PUT', base, state);
  state = await data('POST', `${base}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  const scene = state.scenes[0], publicPath = '/overlay-studio/public/' + scene.publicId;
  const publicBundle = await data('GET', `${publicPath}/custom-widgets/${native.id}/1`);
  assert.deepEqual([publicBundle.engine, publicBundle.html], ['dima', dima.html]);
  await req('GET', `${publicPath}/custom-widgets/${native.id}/2`, null, 404);
  await req('GET', `${publicPath}/custom-widgets/${'c'.repeat(24)}/1`, null, 404);
  console.log('PASS widget.json import, owner bundle with channel identity, public bundle only for pinned revisions.');

  // The candidate's own API process serves the overlay socket; this check plays an OBS source.
  const ns = '/overlay-studio/' + scene.publicId, feed = [], reloads = [], policies = [], acks = new Map(); let ackId = 1;
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', event => {
    const m = String(event.data);
    if (m.startsWith('0')) ws.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`);
    else if (m === '2') ws.send('3');
    else if (m.startsWith(`42${ns},`)) { const [name, payload] = JSON.parse(m.slice(m.indexOf(',') + 1)); if (name === 'overlay-feed') feed.push(payload); if (name === 'overlay-widget-reload') reloads.push(payload); if (name === 'overlay-widget-policies') policies.push(payload); }
    else if (m.startsWith(`43${ns},`)) { const rest = m.slice(m.indexOf(',') + 1), id = Number(/^\d+/.exec(rest)[0]); acks.get(id)?.(JSON.parse(rest.slice(String(id).length))[0]); }
  });
  const rpc = (layerId, method, params) => new Promise(resolve => { const id = ackId++; acks.set(id, resolve); ws.send(`42${ns},${id}${JSON.stringify(['overlay-widget-rpc', { layerId, method, params }])}`); });
  const nextFeed = (type, predicate = () => true) => until(() => feed.find(item => item.type === type && predicate(item.data)), 'feed ' + type);

  const session = await nextFeed('session');
  assert.equal(session.v, 1); assert.deepEqual(session.data.data['follower-latest'], { name: '', amount: 0 });
  assert.equal(await until(() => redis.get('widget-feed:demand:' + preview), 'chat demand key'), '1');
  // Each widget's current load rules come with the connection (a page reloads widgets it cached under other rules).
  const connectPolicies = (await until(() => policies[0], 'policies on connect')).networks;
  assert.deepEqual(Object.keys(connectPolicies).sort(), [native.id, seWidget.id, twin.id, pet.id].sort());
  assert.ok(Object.values(connectPolicies).every(network => network === 'open'));
  console.log('PASS source receives its session snapshot and widget load rules; chat demand is published for channels with chat widgets.');

  // Journal alert → Dima alert + refreshed session.
  await DomainEventSchema.create({ eventKey: 'cw-follow', source: 'twitch-eventsub', sourceEventId: 'cw-follow', type: 'channel.follow.received', topic: 'channel', channelID: preview, schemaVersion: 1,
    occurredAt: new Date(), journaledAt: new Date(), expiresAt: new Date(Date.now() + 600000), payload: { subscription: { type: 'channel.follow' }, event: { user_id: '77', user_login: 'luna', user_name: 'Luna' } }, metadata: {} });
  const alert = await nextFeed('alert', item => item.user?.name === 'Luna');
  assert.deepEqual([alert.data.type, alert.data.test, alert.data.user], ['follow', false, { id: '77', login: 'luna', name: 'Luna' }]);
  await nextFeed('session', item => item.data['follower-latest']?.name === 'Luna');
  console.log('PASS journal follow reaches widgets as a Dima alert and refreshes session data.');
  // Busy channels: more alerts than the recent-events scan; latest stays the newest and totals count everything.
  const old = Date.now() - 3 * 24 * 3600_000;
  await DomainEventSchema.insertMany(Array.from({ length: 650 }, (_, i) => ({ eventKey: `cw-old-${i}`, source: 'twitch-eventsub', sourceEventId: `cw-old-${i}`, type: 'channel.follow.received', topic: 'channel', channelID: preview, schemaVersion: 1,
    occurredAt: new Date(old + i), journaledAt: new Date(old + i), expiresAt: new Date(Date.now() + 600000), payload: { subscription: { type: 'channel.follow' }, event: { user_id: `o${i}`, user_login: `old${i}`, user_name: `Old${i}` } }, metadata: {} })));
  const busy = await data('GET', `${widgetsPath}/session`);
  assert.deepEqual([busy.data['follower-latest'].name, busy.data['follower-week'].count, busy.data['follower-session'].count, busy.data['follower-recent'].length], ['Luna', 651, 1, 25]);
  console.log('PASS session data on busy channels: newest latest, week/stream totals across all events.');

  // StreamElements totals, month and "manual" goals: followers/subs from the ledgers, month + 90 days from the journal,
  // *-goal from the Goals page (Studio also learns which goal; OBS doesn't).
  const { FollowRelationshipLedgerSchema } = await import('/app/dist/schemas/follow_relationship_ledger.schema.js');
  const { StreamSubscriptionLedgerSchema } = await import('/app/dist/schemas/stream_subscription_ledger.schema.js');
  const { GoalSet, GoalContribution } = await import('/app/dist/goals/service.js');
  await FollowRelationshipLedgerSchema.collection.insertMany(['f1', 'f2', 'f3', 'f4'].map((id, i) => ({ platform: 'twitch', followed_id: preview, follower_id: id, status: i === 3 ? 'unfollowed' : 'active', followed_at: new Date(), updated_at: new Date() })));
  await StreamSubscriptionLedgerSchema.collection.insertMany(['s1', 's2', 's3'].map((id, i) => ({ platform: 'twitch', streamer_id: preview, user_id: id, status: i === 2 ? 'ended' : 'active', subbed_at: new Date(), last_event_at: new Date() })));
  const bitsEvent = (key, daysAgo, bits) => ({ eventKey: key, source: 'twitch-eventsub', sourceEventId: key, type: 'channel.bits.received', topic: 'channel', channelID: preview, schemaVersion: 1,
    occurredAt: new Date(Date.now() - daysAgo * 86_400_000), journaledAt: new Date(), expiresAt: new Date(Date.now() + 600000), payload: { subscription: { type: 'channel.bits.use' }, event: { user_id: '9', user_login: 'pix', user_name: 'Pix', bits } }, metadata: {} });
  await DomainEventSchema.insertMany([bitsEvent('cw-bits-40', 40, 300), bitsEvent('cw-bits-100', 100, 5000)]);
  const startedAt = Date.now() - 3_600_000;
  await GoalSet.collection.insertOne({ _id: preview, revision: 1, outcomes: {}, monthlyCursors: {}, goals: [
    { id: 'g-follow', name: 'Road to 100', metric: 'follows', mode: 'total', target: 100, createdAt: startedAt, startsAt: startedAt },
    { id: 'g-money', name: 'Charity', metric: 'currency', mode: 'total', target: 50_000, createdAt: startedAt, startsAt: startedAt, currency: { code: 'USD', bitValue: 1, subscriptionValue: 250, items: [] } }] });
  await GoalContribution.collection.insertMany([{ _id: 'c1', channel: preview, goal: 'g-follow', occurredAt: Date.now() - 1000, amount: 7 }, { _id: 'c2', channel: preview, goal: 'g-money', occurredAt: Date.now() - 1000, amount: 1234 }]);
  const full = await data('GET', `${widgetsPath}/session`), monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  assert.deepEqual([full.data['follower-total'], full.data['subscriber-total']], [{ count: 3 }, { count: 2 }], 'current followers and subscribers');
  assert.deepEqual(full.data['follower-month'], { count: 1 + (old >= monthStart ? 650 : 0) });
  assert.deepEqual([full.data['cheer-total'], full.data['cheer-month']], [{ amount: 300 }, { amount: 0 }], 'Bits over the 90 retained days; month = this UTC calendar month');
  assert.deepEqual([full.data['follower-goal'], full.data['tip-goal'], full.data['subscriber-goal']], [{ amount: 7 }, { amount: 12.34 }, { amount: 0 }], '*-goal from the Goals page (currency in cents)');
  assert.deepEqual([full.goalSources['follower-goal'].name, full.goalSources['tip-goal'].name, full.goalSources['subscriber-goal']], ['Road to 100', 'Charity', undefined]);
  // The follower ledger is a periodic Twitch sync: follows journaled after its last change count right away.
  await DomainEventSchema.create({ eventKey: 'cw-follow-live', source: 'twitch-eventsub', sourceEventId: 'cw-follow-live', type: 'channel.follow.received', topic: 'channel', channelID: preview, schemaVersion: 1,
    occurredAt: new Date(Date.now() + 1000), journaledAt: new Date(), expiresAt: new Date(Date.now() + 600000), payload: { subscription: { type: 'channel.follow' }, event: { user_id: '78', user_login: 'sol', user_name: 'Sol' } }, metadata: {} });
  assert.deepEqual((await data('GET', `${widgetsPath}/session`)).data['follower-total'], { count: 4 }, 'ledger (3) + a follow after the last sync');
  console.log('PASS StreamElements totals (ledgers + live follows), month and 90-day counts (journal) and "manual" goals from the Goals page.');

  // Chat from the bot's pub/sub channel.
  const chat = { id: 'm1', platform: 'twitch', at: Date.now(), user: { id: '5', login: 'ada', name: 'Ada', color: null, badges: [], roles: {}, subMonths: null }, text: 'hello', parts: [{ type: 'text', text: 'hello' }],
    kind: 'text', action: false, firstMessage: false, bits: 0, rewardId: null, reply: null, sharedChat: null };
  const publisher = redis.duplicate(); await publisher.connect();
  await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type: 'chat', data: chat }));
  assert.equal((await nextFeed('chat', item => item.id === 'm1')).data.text, 'hello');
  await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type: 'chat.delete', data: { messageId: 'm1', userId: '5' } }));
  await nextFeed('chat.delete', item => item.messageId === 'm1');
  await publisher.publish('widget-feed', JSON.stringify({ channel: '999', type: 'chat', data: { ...chat, id: 'other-channel' } }));
  await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type: 'nonsense', data: {} }));
  await new Promise(r => setTimeout(r, 300));
  assert(!feed.some(item => item.data?.id === 'other-channel' || item.type === 'nonsense'), 'only this channel and known types');
  console.log('PASS chat, deletes from the bot feed reach this channel only.');

  // Goal progress applied elsewhere (cron) asks for a session refresh: OBS gets the new "manual" goal, never goalSources.
  await GoalContribution.collection.insertOne({ _id: 'c3', channel: preview, goal: 'g-follow', occurredAt: Date.now() - 500, amount: 2 });
  await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type: 'session.refresh', data: {} }));
  const refreshed = await nextFeed('session', item => item.data['follower-goal']?.amount === 9);
  assert.deepEqual([refreshed.data.data['follower-total'], 'goalSources' in refreshed.data, feed.some(item => item.type === 'session' && 'goalSources' in item.data)], [{ count: 4 }, false, false]);
  console.log('PASS goal changes refresh OBS session data (manual goal 7 → 9); goal names stay in Studio.');

  // Command signals from the bot: only layers whose widgets use signals; widget.signal.to picks layers by name.
  const signal = (name, target = null, extra = {}) => ({ id: 'sig-' + name, name, value: 'pizza', json: null, args: ['pizza'], at: Date.now(), user: null, source: { kind: 'command', name }, target, ...extra });
  const sendSignal = (data, channel = preview) => publisher.publish('widget-feed', JSON.stringify({ channel, type: 'signal', data }));
  await sendSignal(signal('feed'));
  assert.deepEqual((await nextFeed('signal', item => item.id === 'sig-feed')).layers.sort(), ['pet-layer', 'pet2-layer']);
  await sendSignal(signal('focus', ' pet CORNER '));
  assert.deepEqual((await nextFeed('signal', item => item.id === 'sig-focus')).layers, ['pet-layer']);
  for (const data of [signal('nobody', 'Nobody'), signal('bad.name'), signal('long', null, { value: 'x'.repeat(501) })]) await sendSignal(data);
  await sendSignal(signal('elsewhere'), '999');
  await sendSignal(signal('after'));
  await nextFeed('signal', item => item.id === 'sig-after');
  assert.deepEqual(feed.filter(item => item.type === 'signal').map(item => item.data.id), ['sig-feed', 'sig-focus', 'sig-after'], 'no unknown layer names, invalid signals or other channels');
  console.log('PASS command signals reach layers that use them; .to targets one layer by name; invalid ones and other channels never.');

  // Live state for widgets that use it: goals (public projection, never actions) and polls (same sanitized read as built-in poll widgets).
  const goalsState = (await nextFeed('state', item => item.name === 'goals' && item.value.length > 0)).data.value;
  assert.deepEqual(goalsState.map(goal => [goal.id, goal.name, goal.metric, goal.current, goal.target, goal.currency]), [['g-follow', 'Road to 100', 'follows', 9, 100, null], ['g-money', 'Charity', 'currency', 12.34, 500, 'USD']]);
  assert(goalsState.every(goal => !('actions' in goal) && !('outcome' in goal)), 'no completion actions or outcomes');
  const { applyInteractionEvent } = await import('/app/dist/overlays/interactions.js');
  const pollAt = new Date().toISOString();
  await applyInteractionEvent({ source: 'twitch-eventsub', channelID: preview, sourceEventId: 'cw-poll-1', occurredAt: new Date(), metadata: { messageTimestamp: pollAt },
    payload: { subscription: { type: 'channel.poll.begin' }, event: { id: 'poll-1', title: 'Next game?', started_at: pollAt, ends_at: new Date(Date.now() + 60000).toISOString(),
      choices: [{ id: 'a', title: 'Celeste', votes: 0 }, { id: 'b', title: 'Hades', votes: 0 }] } } });
  const polls = (await nextFeed('state', item => item.name === 'polls' && item.value.poll?.id === 'poll-1')).data.value;
  assert.deepEqual([polls.poll.title, polls.poll.phase, polls.poll.choices.map(choice => choice.title), polls.prediction], ['Next game?', 'active', ['Celeste', 'Hades'], null]);
  assert.equal(feed.filter(item => item.type === 'state' && item.data.name === 'polls').length >= 1, true);
  console.log('PASS live state: goals (public projection) and polls (sanitized) reach widgets that use them.');

  // Bot events: channel-point redemptions from the bot (once per redemption, known fields only); triggers on a custom-only overlay.
  const redemption = { id: 'redeem-1', reward: { id: 'r1', title: 'Hydrate!', cost: 500, secret: 'x' }, user: { id: '9', login: 'pix', name: 'Pix' }, input: 'drink water', at: 1, test: true, extra: 'drop me' };
  for (const data of [redemption, redemption, { id: '', reward: {} }]) await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type: 'reward', data }));
  await sendSignal(signal('after_rewards'));
  await nextFeed('signal', item => item.id === 'sig-after_rewards');
  const rewards = feed.filter(item => item.type === 'reward');
  assert.deepEqual(rewards.map(item => item.data), [{ id: 'redeem-1', reward: { id: 'r1', title: 'Hydrate!', cost: 500 }, user: { id: '9', login: 'pix', name: 'Pix' }, input: 'drink water', at: 1, test: false }]);
  const sent = await data('POST', `/triggers/${preview}/send`, { name: 'Airhorn', url: 'https://example.invalid/airhorn.mp3', mediaType: 'audio/mpeg', volume: 80 });
  assert.equal(sent.activeConnections, 0);
  const trigger = (await nextFeed('trigger', item => item.name === 'Airhorn')).data;
  assert.deepEqual([trigger.triggerId, trigger.mediaType, trigger.test, 'url' in trigger, 'volume' in trigger], ['', 'audio', false, false, false]);
  console.log('PASS bot events: redemptions once with known fields only; triggers reach custom-only overlays without media URLs.');

  // Pets and duels from other processes: validated, known fields only, once per phase.
  const petReply = { id: 'pr-1', kind: 'ask', phase: 'speaking', text: 'Hi!', mood: 'happy', result: null, at: 1, test: true, ownerId: 'internal', prompt: 'viewer prompt' };
  const duelRun = phase => ({ id: 'duel-1', phase, challenger: 'ada', opponent: 'pix', mode: 'overlay', winner: phase === 'ended' ? 'pix' : 'leak', loser: phase === 'ended' ? 'ada' : 'leak', endsAt: 5, at: 1, turns: [] });
  const lateDone = { id: 'pr-2', kind: 'talk', phase: 'done', text: 'Bye', mood: null, result: 'stopped', at: 2 };
  for (const [type, data] of [['pet', petReply], ['pet', petReply], ['pet', { id: 'bad', kind: 'hack', phase: 'speaking' }],
    ['pet', lateDone], ['pet', { ...lateDone, phase: 'speaking', result: null }], // another process's `speaking` lands after `done`
    ['duel', duelRun('started')], ['duel', duelRun('started')], ['duel', duelRun('ended')],
    ['roulette', { id: 'spin-pubsub', rouletteId: 'r1', name: 'Punishments', endsAt: Date.now() + 1000, label: 'Early leak', at: 1 }]]) { // old producer format: ignored now
    await publisher.publish('widget-feed', JSON.stringify({ channel: preview, type, data }));
  }
  // Roulette events come from the saved spin (Mongo): `spinning` without the label, the result when it ends, and a result
  // from the last 2 minutes for a source that (re)connects, so an API restart or OBS reconnect loses nothing.
  const { RouletteChannel } = await import('/app/dist/roulette/service.js');
  const spinEnds = Date.now() + 1500, done = (id, endsAt, label) => ({ id, rouletteId: 'r1', startedAt: endsAt - 5000, endsAt, completedAt: endsAt, winner: { key: 'k', itemId: 'i', label } });
  await RouletteChannel.collection.insertOne({ _id: preview, revision: 1, state: { roulettes: [{ id: 'r1', name: 'Punishments', items: [] }], activeId: 'r1', visible: true, hideAt: null,
    draw: { id: 'spin-1', rouletteId: 'r1', startedAt: Date.now(), endsAt: spinEnds, completedAt: null, winner: { key: 'k', itemId: 'i', label: 'Sing a song' }, slots: [] },
    history: [done('spin-recent', Date.now() - 30_000, 'Dance'), done('spin-stale', Date.now() - 600_000, 'Stale')] } });
  const spinning = (await nextFeed('roulette', item => item.id === 'spin-1')).data;
  assert.deepEqual([spinning.phase, spinning.label, spinning.name], ['spinning', null, 'Punishments'], 'the label stays on the server until the spin ends');
  assert.equal((await nextFeed('roulette', item => item.id === 'spin-recent')).data.label, 'Dance', 'a result from the last 2 minutes');
  const result = (await nextFeed('roulette', item => item.id === 'spin-1' && item.phase === 'result')).data;
  assert.equal(result.label, 'Sing a song'); assert.ok(Date.now() >= spinEnds - 50, 'result at the end of the spin');
  // An OBS source that reconnects after the end (or after an API restart) still gets the result.
  const late = [], lateWs = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  lateWs.addEventListener('message', event => {
    const m = String(event.data);
    if (m.startsWith('0')) lateWs.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`);
    else if (m === '2') lateWs.send('3');
    else if (m.startsWith(`42${ns},`)) { const [name, payload] = JSON.parse(m.slice(m.indexOf(',') + 1)); if (name === 'overlay-feed' && payload.type === 'roulette') late.push(payload.data); }
  });
  await until(() => late.some(item => item.id === 'spin-1' && item.phase === 'result' && item.label === 'Sing a song'), 'result after a reconnect');
  lateWs.close();
  await new Promise(resolve => setTimeout(resolve, 1200));
  const pets = feed.filter(item => item.type === 'pet').map(item => item.data), duels = feed.filter(item => item.type === 'duel').map(item => item.data);
  assert.deepEqual(pets, [{ id: 'pr-1', kind: 'ask', phase: 'speaking', text: 'Hi!', mood: 'happy', result: null, at: 1, test: false },
    { id: 'pr-2', kind: 'talk', phase: 'done', text: 'Bye', mood: null, result: 'stopped', at: 2, test: false }], 'a late `speaking` after `done` is dropped');
  assert.deepEqual(duels.map(duel => [duel.phase, duel.winner, duel.loser, 'turns' in duel]), [['started', null, null, false], ['ended', 'pix', 'ada', false]]);
  assert.deepEqual(feed.filter(item => item.type === 'roulette').map(item => [item.data.id, item.data.phase, item.data.label]).sort(),
    [['spin-1', 'result', 'Sing a song'], ['spin-1', 'spinning', null], ['spin-recent', 'result', 'Dance']], 'once each; stale results and pub/sub labels never reach widgets');
  console.log('PASS pets, duels and roulette: validated and once per phase in order; no winner before the end; roulette results from the saved spin, also after a reconnect.');

  // Hype trains and ad breaks: the journal consumer (cron) applies them; its handler runs here on the same database.
  const { resyncHypeTrain } = await import('/app/dist/overlays/interactions.js');
  const envelope = (type, event, id, at = new Date()) => ({ source: 'twitch-eventsub', channelID: preview, sourceEventId: id, occurredAt: at, metadata: { messageTimestamp: at.toISOString() },
    payload: { subscription: { type, version: type.startsWith('channel.hype_train.') ? '2' : '1' }, event } });
  const contributor = (id, type, total) => ({ user_id: id, user_login: 'user' + id, user_name: 'User' + id, type, total });
  const trainStart = new Date(Date.now() - 60_000).toISOString(), trainEvent = extra => ({ id: 'train-1', broadcaster_user_id: preview, total: 137, progress: 137, goal: 500, level: 1,
    top_contributions: [contributor('1', 'bits', 137)], shared_train_participants: null, started_at: trainStart, expires_at: new Date(Date.now() + 300_000).toISOString(), type: 'regular', is_shared_train: false, ...extra });
  const hypeState = predicate => nextFeed('state', item => item.name === 'hypetrain' && predicate(item.value));
  await hypeState(value => value === null); // known: none running (Helix said so on connect)
  // Recovery with nothing stored yet: Twitch's running train, with the channel record from its `all_time_high`.
  helix('hypetrain', { body: { data: [{ current: trainEvent({ id: 'train-0', started_at: new Date(Date.now() - 600_000).toISOString(), total: 40 }),
    all_time_high: { level: 5, total: 9000, achieved_at: new Date().toISOString() }, shared_all_time_high: null }] } });
  await resyncHypeTrain(preview);
  assert.deepEqual((await hypeState(value => value?.id === 'train-0')).data.value.allTimeHigh, { level: 5, total: 9000 }, 'record from Helix');
  await applyInteractionEvent(envelope('channel.hype_train.begin', trainEvent({ all_time_high_level: 3, all_time_high_total: 4000 }), 'h1'));
  const begun = (await hypeState(value => value?.id === 'train-1')).data.value;
  assert.deepEqual([begun.phase, begun.level, begun.total, begun.allTimeHigh, begun.topContributions, typeof begun.startedAt],
    ['active', 1, 137, { level: 3, total: 4000 }, [{ user: { id: '1', login: 'user1', name: 'User1' }, type: 'bits', total: 137 }], 'number']);
  await applyInteractionEvent(envelope('channel.hype_train.progress', trainEvent({ total: 90 }), 'h2', new Date(Date.now() + 1)));
  await applyInteractionEvent(envelope('channel.hype_train.progress', trainEvent({ total: 600, level: 2, progress: 100, goal: 700 }), 'h3'));
  assert.equal((await hypeState(value => value?.total === 600)).data.value.allTimeHigh.level, 3, 'progress keeps the record; a lower total never shows');
  // A slow Helix answer doesn't overwrite a newer EventSub update.
  helix('hypetrain', { delayMs: 600, body: { data: [{ current: trainEvent({ total: 50 }), all_time_high: { level: 3, total: 4000 } }] } });
  await new Promise(resolve => setTimeout(resolve, 1100)); // past the (check) coalescing window
  const slow = resyncHypeTrain(preview);
  await new Promise(resolve => setTimeout(resolve, 100));
  await applyInteractionEvent(envelope('channel.hype_train.progress', trainEvent({ total: 700, level: 2 }), 'h4'));
  await slow;
  await hypeState(value => value?.total === 700);
  await applyInteractionEvent(envelope('channel.hype_train.end', { id: 'train-1', broadcaster_user_id: preview, total: 900, level: 3, top_contributions: [contributor('1', 'bits', 600)],
    started_at: trainStart, ended_at: new Date().toISOString(), cooldown_ends_at: new Date(Date.now() + 3_600_000).toISOString(), type: 'regular', is_shared_train: false }, 'h5'));
  const ended = (await hypeState(value => value?.phase === 'ended')).data.value;
  assert.deepEqual([ended.level, ended.total, ended.progress, typeof ended.cooldownEndsAt], [3, 900, null, 'number']);
  await applyInteractionEvent(envelope('channel.hype_train.progress', trainEvent({ total: 950 }), 'h6'));
  // A train whose end event never came: Twitch says none is running, so it clears.
  await applyInteractionEvent(envelope('channel.hype_train.begin', trainEvent({ id: 'train-2', started_at: new Date().toISOString(), expires_at: new Date(Date.now() - 30_000).toISOString() }), 'h7'));
  await hypeState(value => value?.id === 'train-2');
  // The API notices it's overdue and asks Twitch itself (recovery is coalesced: 1 s in checks, a minute in production).
  const before = helixCalls('hypetrain');
  helix('hypetrain', { body: { data: [{ current: null, all_time_high: { level: 3, total: 4000 }, shared_all_time_high: null }] } });
  await hypeState(value => value === null && feed.some(item => item.type === 'state' && item.data.name === 'hypetrain' && item.data.value?.id === 'train-2')
    && feed.findLastIndex(item => item.type === 'state' && item.data.name === 'hypetrain' && item.data.value === null) > feed.findLastIndex(item => item.type === 'state' && item.data.value?.id === 'train-2'));
  assert.ok(helixCalls('hypetrain') > before, 'the API asked Twitch');
  assert.ok(!feed.some(item => item.type === 'state' && item.data.name === 'hypetrain' && item.data.value?.total === 950), 'never back to active after the end');
  console.log('PASS hype trains: journaled v2 events become live state (public fields, ordered, record kept), slow recovery fenced, "none running" clears a stuck train.');

  // Ads: a running break computed against now (its end needs no timer), and the schedule from Twitch.
  const adsState = predicate => nextFeed('state', item => item.name === 'ads' && predicate(item.value));
  const schedule = (await adsState(value => value?.schedule?.nextAt === nextAdAt)).data.value.schedule;
  assert.deepEqual(schedule, { nextAt: nextAdAt, duration: 90, lastAt: null, snoozes: 3, snoozeRefreshAt: schedule.snoozeRefreshAt, prerollFreeUntil: null });
  const adsCalls = helixCalls('ads'), adStart = new Date();
  await applyInteractionEvent(envelope('channel.ad_break.begin', { broadcaster_user_id: preview, requester_user_id: '9', requester_user_login: 'editor', requester_user_name: 'Editor',
    duration_seconds: 2, started_at: adStart.toISOString(), is_automatic: false }, 'ad-1'));
  const running = (await adsState(value => value?.active)).data.value.active;
  assert.deepEqual(running, { startedAt: adStart.getTime(), endsAt: adStart.getTime() + 2000, duration: 2, automatic: false }, 'no requester identity');
  const adsStates = () => feed.filter(item => item.type === 'state' && item.data.name === 'ads').map(item => item.data.value);
  await until(() => { const all = adsStates(), at = all.findIndex(value => value.active); return at >= 0 && all.slice(at + 1).some(value => value.active === null); }, 'the break ends without a timer', 200);
  await until(() => helixCalls('ads') > adsCalls, 'schedule asked again after a break', 400);
  console.log('PASS ads: a running break (ends without a timer), the ad schedule from Twitch, asked again after a break.');

  // Widget RPC: store (namespaced per engine), counters, permissions and limits.
  assert.deepEqual(await rpc('dima-layer', 'store.set', { key: 'alerts', value: { count: 5, 'a.b': '$x' } }), { ok: true, value: true });
  assert.deepEqual(await rpc('dima-layer', 'store.get', { key: 'alerts' }), { ok: true, value: { count: 5, 'a.b': '$x' } });
  const storeEvent = (await nextFeed('storage', item => item.key === 'alerts')).data;
  assert.deepEqual([storeEvent.value, storeEvent.namespace], [{ count: 5, 'a.b': '$x' }, native.id], 'store updates name their store so frames apply only their own');
  assert.deepEqual(await rpc('twin-layer', 'store.get', { key: 'alerts' }), { ok: true, value: null }, 'two Dima widgets never share keys');
  assert.deepEqual(await rpc('twin-layer', 'store.set', { key: 'alerts', value: 'twin' }), { ok: true, value: true });
  assert.equal((await nextFeed('storage', item => item.key === 'alerts' && item.value === 'twin')).data.namespace, twin.id);
  assert.deepEqual(await rpc('dima-layer', 'store.get', { key: 'alerts' }), { ok: true, value: { count: 5, 'a.b': '$x' } });
  assert.deepEqual(await rpc('dima-layer', 'counters.get', { name: '!deaths' }), { ok: true, value: 7 });
  assert.deepEqual(await rpc('dima-layer', 'counters.get', { name: 'nope' }), { ok: true, value: 0 });
  for (const [layerId, method, params, pattern] of [['se-layer', 'store.set', { key: 'x', value: 1 }, /did not ask for "storage"/], ['ghost', 'store.get', { key: 'x' }, /Widget not found/],
    ['dima-layer', 'store.set', { key: 'big', value: 'x'.repeat(64_001) }, /64 KB/], ['dima-layer', 'store.set', { key: '', value: 1 }, /1–100/], ['dima-layer', 'eval', {}, /Unknown/]]) {
    const result = await rpc(layerId, method, params); assert.equal(result.ok, false); assert.match(result.error, pattern);
  }
  const burst = await Promise.all(Array.from({ length: 25 }, () => rpc('dima-layer', 'counters.get', { name: 'deaths' })));
  assert(burst.some(result => result.ok === false && /Too many/.test(result.error)), 'per-source rate limit');
  assert.deepEqual(await data('GET', `${widgetsPath}/store/${native.id}/alerts`), { value: { count: 5, 'a.b': '$x' } });
  assert.deepEqual(await data('GET', `${widgetsPath}/store/se/alerts`), { value: null }, 'SE and Dima widgets use separate namespaces');
  assert.deepEqual(await data('GET', `${widgetsPath}/counters/deaths`), { value: 7 });
  assert.equal(typeof (await data('GET', `${widgetsPath}/session`)).data['follower-session'].count, 'number');
  console.log('PASS widget RPC: namespaced JSON store with change events, command counters, manifest permissions, limits and rate limit.');

  // Studio tests to OBS.
  const testChat = { ...chat, id: 'test-chat' };
  assert.equal((await data('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'chat', data: testChat })).clients, 1);
  await nextFeed('chat', item => item.id === 'test-chat');
  await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'storage', data: {} }, 400);
  await req('POST', `${base}/widget-test`, { sceneId: 'missing', type: 'chat', data: testChat }, 409);
  const obs = await data('POST', `${base}/test`, { kind: 'follow', sceneId: scene.id, destination: 'obs', confirmed: true, user: 'Tester' });
  assert.deepEqual([obs.sent, obs.clients], [true, 0], 'overlays with only custom widgets skip the alert queue');
  const testAlert = await nextFeed('alert', item => item.test === true);
  assert.deepEqual([testAlert.data.type, testAlert.data.user.name], ['follow', 'Tester']);
  // After a test alert to OBS, Studio sends the session totals it leads to (tests aren't journaled).
  const testSession = { data: { 'follower-session': { count: 42 } }, recents: [] };
  assert.equal((await data('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'session', data: testSession })).clients, 1);
  assert.equal((await nextFeed('session', item => item.data['follower-session']?.count === 42)).data.recents.length, 0);
  await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'session', data: { data: [], recents: [] } }, 400);
  console.log('PASS Studio chat and alert tests reach the published overlay\'s widgets; test session totals follow test alerts.');

  // Studio tests for bot events and sample state: stamped as tests; unknown state names refused.
  for (const [type, payload] of [['tts', { id: 't1', phase: 'start', text: 'hi', user: null, reason: null, at: 1 }], ['trigger', { id: 'tr1', triggerId: '', name: 'Bell', mediaType: 'audio', at: 1 }],
    ['reward', { id: 'rw1', reward: { id: 'r', title: 'T', cost: 1 }, user: null, input: null, at: 1 }], ['state', { name: 'goals', value: [{ id: 'sample' }] }], ['state', { name: 'ads', value: { active: null, schedule: { nextAt: 1 } } }]]) {
    assert.equal((await data('POST', `${base}/widget-test`, { sceneId: scene.id, type, data: payload })).clients, 1, type);
  }
  assert.equal((await nextFeed('tts', item => item.id === 't1')).data.test, true);
  assert.equal((await nextFeed('reward', item => item.id === 'rw1')).data.test, true);
  await nextFeed('state', item => item.name === 'goals' && item.value[0]?.id === 'sample');
  await nextFeed('state', item => item.name === 'ads' && item.value?.schedule?.nextAt === 1);
  await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'state', data: { name: 'secrets', value: {} } }, 400);
  // Studio's preview routes: real state and replayed chat (oldest first, text only).
  const studioState = await data('GET', `${widgetsPath}/state`);
  assert.deepEqual([studioState.polls.poll.id, studioState.goals.map(goal => goal.id)], ['poll-1', ['g-follow', 'g-money']]);
  assert.deepEqual([studioState.hypetrain, studioState.ads.active, studioState.ads.schedule.nextAt], [null, null, nextAdAt], 'Studio previews start from the real hype train and ads state');
  for (const entry of [{ username: 'Old', message: 'first', timestamp: 1, badges: ['[VIP]'] }, { username: 'New', message: 'second', timestamp: 2, messageID: 'n2', badges: [] }]) await redis.lPush(`twitch:${preview}:chat:history`, JSON.stringify(entry));
  const replay = (await data('GET', `${widgetsPath}/chat-history`)).messages;
  assert.deepEqual(replay.map(message => [message.user.name, message.text, message.user.roles.vip]), [['Old', 'first', true], ['New', 'second', false]]);
  console.log('PASS Studio: bot event and state tests (stamped), live state and chat replay routes.');
  // Block outside connections: OBS sources showing the widget are asked to load it again (it's cached per revision).
  await data('PATCH', `${widgetsPath}/${pet.id}`, { network: 'restricted' });
  await until(() => reloads.some(item => item.widgetId === pet.id), 'reload asked');
  assert.equal((await data('GET', `/overlay-studio/public/${scene.publicId}/custom-widgets/${pet.id}/1`)).network, 'restricted');
  const asked = reloads.length;
  await data('PATCH', `${widgetsPath}/${pet.id}`, { name: 'Pet' }); // no change to the rules: no reload
  await data('PATCH', `${widgetsPath}/${pet.id}`, { network: 'open' });
  await until(() => reloads.length === asked + 1, 'reload asked again');
  await data('PATCH', `${widgetsPath}/${twin.id}`, { network: 'restricted' });
  await until(() => reloads.at(-1)?.widgetId === twin.id, 'each widget asks for itself');
  await data('PATCH', `${widgetsPath}/${twin.id}`, { network: 'open' });
  await until(() => reloads.length === asked + 3, 'twin open again');
  assert.deepEqual(reloads.slice(asked).map(item => item.widgetId), [pet.id, twin.id, twin.id]);
  console.log('PASS Block outside connections: OBS sources showing the widget load it again with the new rules (not for a rename).');

  // Studio signal tests: stamped by the server (sender = owner, source = Studio), name-targeted, counted in the channel limit.
  const forged = { id: 'forged', name: 'Feed', value: ' pizza ', target: 'chat box', user: { id: 'evil', login: 'evil', name: 'Evil', roles: { broadcaster: true } }, source: { kind: 'command', name: 'x' }, at: 1 };
  assert.equal((await data('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'signal', data: forged })).clients, 1);
  const stamped = await nextFeed('signal', item => item.source.kind === 'studio');
  assert.deepEqual([stamped.layers, stamped.data.name, stamped.data.value, stamped.data.target, stamped.data.user.id, stamped.data.user.login, stamped.data.user.roles.broadcaster],
    [['pet2-layer'], 'feed', 'pizza', 'chat box', preview, 'cdom201', true]);
  assert(stamped.data.id !== 'forged' && stamped.data.at > 1, 'id and time come from the server');
  assert.match((await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'signal', data: { name: 'pet.feed', value: '' } }, 400)).message, /Signal names/);
  await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'signal', data: { name: 'feed', value: '', target: 'Nobody' } }, 409);
  assert.deepEqual(await data('GET', `${widgetsPath}/signals`), { skipped: 0 });
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await fetch(`http://127.0.0.1:3000${base}/widget-test`, { method: 'POST', headers: { Authorization: 'Bearer cwe-' + preview, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: scene.id, type: 'signal', data: { name: 'burst', value: String(i), target: null } }) })).status);
  assert(statuses.slice(0, 25).every(status => status === 200) && statuses.at(-1) === 429, `30 signals per 10 s per channel (got ${statuses.join(',')})`);
  assert((await data('GET', `${widgetsPath}/signals`)).skipped >= 1, 'skipped signals are counted for Studio');
  console.log('PASS Studio signal tests: server-stamped sender and source, layer targeting, name rules, channel limit with a skipped count.');

  // Media copying: plan with sizes and storage, copy, serve to the pinned overlay, protect from deletion.
  const plan = await data('GET', `${widgetsPath}/${seWidget.id}/media`);
  assert.deepEqual(plan.files.map(file => [file.url.split('/').pop(), file.bytes, file.copied]), [['fixture-sparkle.png', 70, false], ['fixture-alert.png', 70, false]]);
  assert.equal(plan.totalBytes, 140); assert.equal(plan.quota.quotaBytes, 500_000_000);
  const copied = await data('POST', `${widgetsPath}/${seWidget.id}/media`, { urls: plan.files.map(file => file.url) });
  assert.equal(Object.keys(copied.copied).length, 2); assert.deepEqual(copied.failed, []);
  const assetId = Object.values(copied.copied)[0];
  assert.equal((await data('GET', `${widgetsPath}/${seWidget.id}/bundle`)).media[plan.files[0].url], assetId);
  assert((await data('GET', `${widgetsPath}/${seWidget.id}/media`)).files.every(file => file.copied));
  const servedAsset = await fetch(`http://127.0.0.1:3000${publicPath}/assets/${assetId}`);
  assert.equal(servedAsset.status, 200); assert.equal((await servedAsset.arrayBuffer()).byteLength, 70);
  await req('DELETE', `/asset-library/${preview}/${assetId}`.replace('/overlay-studio', ''), null, 409);
  // Studio preview links: copied widget files last a working session (they load whenever a sound plays); others stay short.
  const life = async query => { const { path } = await data('GET', `/asset-library/${preview}/${assetId}/access${query}`);
    const claims = JSON.parse(Buffer.from(new URL(path, 'http://x').searchParams.get('ticket').split('.')[1], 'base64url').toString());
    assert.equal((await fetch(`http://127.0.0.1:3000${path}`)).status, 200); return claims.exp - claims.iat; };
  assert.deepEqual([await life('?for=custom-widget'), await life('')], [12 * 3600, 15 * 60]);
  console.log('PASS media copy: sizes vs storage, copied into the Asset Library, served to the pinned overlay, protected while used.');
  const risky = (await data('POST', widgetsPath, { name: 'Redirects', files: { ...sample, data: '{}', css: sample.css.replace(/fixture-sparkle\.png/, 'redirect-private.png') + '\n.x{background:url("https://cdn.streamelements.com/uploads/redirect-away.png")}' } }, 201)).widget;
  const riskyPlan = await data('GET', `${widgetsPath}/${risky.id}/media`);
  assert.deepEqual(riskyPlan.files.map(file => [file.url.split('/').pop(), file.bytes]), [['redirect-private.png', null], ['redirect-away.png', null]]);
  const riskyCopy = await data('POST', `${widgetsPath}/${risky.id}/media`, { urls: riskyPlan.files.map(file => file.url) });
  assert.deepEqual([Object.keys(riskyCopy.copied).length, riskyCopy.failed.map(item => item.reason)], [0, ['download_failed', 'download_failed']]);
  console.log('PASS media copy refuses redirects to private addresses or other sites.');
  ws.close(); await publisher.quit();
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  s3.close(); process.exit(process.exitCode ?? 0);
}
