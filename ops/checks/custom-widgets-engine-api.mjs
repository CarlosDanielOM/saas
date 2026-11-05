// saas-ops only (api target): disposable Mongo/Redis, fake S3 + fake StreamElements CDN.
// Stage into --fixtures: custom-widget-fixtures/{providers.mjs,sample-chat,dima-chat} and
// overlay-fixtures/providers.mjs as base-providers.mjs. Test env: custom-widget-fixtures/test-env.json.
// Covers the widget engine's server side: widget.json, owner/public bundles, the overlay-feed socket
// (session, journal alerts, chat from the bot's pub/sub, store events, Studio tests), widget RPC
// (store, counters, limits, manifest permissions), chat demand, media copying and copied-asset serving.
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
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: preview, name: 'CDom201' }], plan_tier: 'premium' });
await redis.hSet('token:cwe-' + preview, { id: preview, login: 'cdom201', display_name: 'CDom201' });
await CommandsSchema.collection.insertOne({ channelID: preview, cmd: 'deaths', count: 7, activation: 'command' });

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
  assert.deepEqual([native.name, native.manifest.engine, native.manifest.uses], ['Dima sample chat', 'dima', ['chat', 'alerts', 'store', 'counters', 'session']]);
  const seWidget = (await data('POST', widgetsPath, { files: sample }, 201)).widget;
  const twin = (await data('POST', widgetsPath, { name: 'Second Dima widget', files: dima }, 201)).widget;
  assert.deepEqual([seWidget.manifest.engine, seWidget.manifest.uses, seWidget.manifest.inferred], ['streamelements', ['chat', 'alerts'], true]);
  assert.match((await req('POST', widgetsPath, { files: { ...dima, manifest: '{"api":9}' } }, 400)).message, /newer widget engine/);
  const ownerBundle = await data('GET', `${widgetsPath}/${native.id}/bundle`);
  assert.deepEqual([ownerBundle.engine, ownerBundle.js, ownerBundle.revision, ownerBundle.channel], ['dima', dima.js, 1, { id: preview, login: 'cdom201', name: 'CDom201' }]);
  assert.equal(await (await fetch(`http://127.0.0.1:3000${widgetsPath}/${native.id}/files/manifest`, { headers: { Authorization: 'Bearer cwe-' + preview } })).text(), dima.manifest);

  // Publish both widgets in one overlay.
  let state = await data('GET', base);
  const layer = (id, widgetId) => ({ id, kind: 'custom', configVersion: 1, x: 0, y: 0, width: 480, height: 640, visible: true, locked: false, config: { widgetId } });
  state.scenes[0].widgets = [layer('dima-layer', native.id), layer('se-layer', seWidget.id), layer('twin-layer', twin.id)];
  state = await data('PUT', base, state);
  state = await data('POST', `${base}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  const scene = state.scenes[0], publicPath = '/overlay-studio/public/' + scene.publicId;
  const publicBundle = await data('GET', `${publicPath}/custom-widgets/${native.id}/1`);
  assert.deepEqual([publicBundle.engine, publicBundle.html], ['dima', dima.html]);
  await req('GET', `${publicPath}/custom-widgets/${native.id}/2`, null, 404);
  await req('GET', `${publicPath}/custom-widgets/${'c'.repeat(24)}/1`, null, 404);
  console.log('PASS widget.json import, owner bundle with channel identity, public bundle only for pinned revisions.');

  // The candidate's own API process serves the overlay socket; this check plays an OBS source.
  const ns = '/overlay-studio/' + scene.publicId, feed = [], acks = new Map(); let ackId = 1;
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', event => {
    const m = String(event.data);
    if (m.startsWith('0')) ws.send(`40${ns},${JSON.stringify({ clientId: crypto.randomUUID() })}`);
    else if (m === '2') ws.send('3');
    else if (m.startsWith(`42${ns},`)) { const [name, payload] = JSON.parse(m.slice(m.indexOf(',') + 1)); if (name === 'overlay-feed') feed.push(payload); }
    else if (m.startsWith(`43${ns},`)) { const rest = m.slice(m.indexOf(',') + 1), id = Number(/^\d+/.exec(rest)[0]); acks.get(id)?.(JSON.parse(rest.slice(String(id).length))[0]); }
  });
  const rpc = (layerId, method, params) => new Promise(resolve => { const id = ackId++; acks.set(id, resolve); ws.send(`42${ns},${id}${JSON.stringify(['overlay-widget-rpc', { layerId, method, params }])}`); });
  const nextFeed = (type, predicate = () => true) => until(() => feed.find(item => item.type === type && predicate(item.data)), 'feed ' + type);

  const session = await nextFeed('session');
  assert.equal(session.v, 1); assert.deepEqual(session.data.data['follower-latest'], { name: '', amount: 0 });
  assert.equal(await until(() => redis.get('widget-feed:demand:' + preview), 'chat demand key'), '1');
  console.log('PASS source receives its session snapshot; chat demand is published for channels with chat widgets.');

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

  // Widget RPC: store (namespaced per engine), counters, permissions and limits.
  assert.deepEqual(await rpc('dima-layer', 'store.set', { key: 'alerts', value: { count: 5, 'a.b': '$x' } }), { ok: true, value: true });
  assert.deepEqual(await rpc('dima-layer', 'store.get', { key: 'alerts' }), { ok: true, value: { count: 5, 'a.b': '$x' } });
  const storeEvent = (await nextFeed('store', item => item.key === 'alerts')).data;
  assert.deepEqual([storeEvent.value, storeEvent.namespace], [{ count: 5, 'a.b': '$x' }, native.id], 'store updates name their store so frames apply only their own');
  assert.deepEqual(await rpc('twin-layer', 'store.get', { key: 'alerts' }), { ok: true, value: null }, 'two Dima widgets never share keys');
  assert.deepEqual(await rpc('twin-layer', 'store.set', { key: 'alerts', value: 'twin' }), { ok: true, value: true });
  assert.equal((await nextFeed('store', item => item.key === 'alerts' && item.value === 'twin')).data.namespace, twin.id);
  assert.deepEqual(await rpc('dima-layer', 'store.get', { key: 'alerts' }), { ok: true, value: { count: 5, 'a.b': '$x' } });
  assert.deepEqual(await rpc('dima-layer', 'counters.get', { name: '!deaths' }), { ok: true, value: 7 });
  assert.deepEqual(await rpc('dima-layer', 'counters.get', { name: 'nope' }), { ok: true, value: 0 });
  for (const [layerId, method, params, pattern] of [['se-layer', 'store.set', { key: 'x', value: 1 }, /did not ask for "store"/], ['ghost', 'store.get', { key: 'x' }, /Widget not found/],
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
  await req('POST', `${base}/widget-test`, { sceneId: scene.id, type: 'store', data: {} }, 400);
  await req('POST', `${base}/widget-test`, { sceneId: 'missing', type: 'chat', data: testChat }, 409);
  const obs = await data('POST', `${base}/test`, { kind: 'follow', sceneId: scene.id, destination: 'obs', confirmed: true, user: 'Tester' });
  assert.deepEqual([obs.sent, obs.clients], [true, 0], 'overlays with only custom widgets skip the alert queue');
  const testAlert = await nextFeed('alert', item => item.test === true);
  assert.deepEqual([testAlert.data.type, testAlert.data.user.name], ['follow', 'Tester']);
  console.log('PASS Studio chat and alert tests reach the published overlay\'s widgets.');

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
