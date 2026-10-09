// saas-ops verify api|cron RUN --dependency mongo --dependency redis
// --fixtures ops/checks/widgets-fixtures --test-env ops/checks/widgets-fixtures/test-env.json
// Exercises the real API/cron command with disposable data; never run against production.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
const require = createRequire('/app/package.json');
const svc = await import('/app/dist/widgets/service.js');
const { applyWidgetDomainEvent, createWidgetEventHandler } = await import('/app/dist/widgets/events.js');
const { normalizeTwitchEventsubDomainEvent } = await import('/app/dist/domain_events/twitch_eventsub_events.js');
const { journalDomainEvent } = await import('/app/dist/utils/domain_events.js');
const { dispatchDomainEvents, drainDomainEvents } = await import('/app/dist/utils/domain_event_consumer.js');
const { DOMAIN_EVENT_CONSUMERS } = await import('/app/dist/domain_events/domain_event_consumers.js');
const { DomainEventDeliverySchema } = await import('/app/dist/schemas/domain_event_delivery.schema.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
await getMongoDBConnection('widget-events-check');
const redis = await getDragonflyClient('widget-events-check');
await svc.WidgetChannel.init(); await DomainEventDeliverySchema.init();
const channel = '991901', other = '991902';
await Users.collection.insertMany([
  { accounts: [{ id: channel, type: 'twitch', name: 'widgeteventfixture', chat_enabled: false }], plan_tier: 'premium' },
  { accounts: [{ id: other, type: 'twitch', name: 'otherwidget', chat_enabled: false }], plan_tier: 'pro' }
]);
await redis.hSet('token:widget-events-owner', { id: channel, login: 'widgeteventfixture' });
await redis.hSet('token:widget-events-other', { id: other, login: 'otherwidget' });
let base = 'http://127.0.0.1:3000', localServer, io;
if (process.env.SAAS_TARGET === 'cron') {
  const app = require('express')(); app.use(require('express').json());
  app.use('/widgets', (await import('/app/dist/server/routes/widgets.route.js')).widgetsRoute);
  localServer = createServer(app); io = new (require('socket.io').Server)(localServer);
  (await import('/app/dist/server/services/widgets-overlay.service.js')).registerWidgetOverlay(io);
  await new Promise(resolve => localServer.listen(3211, '127.0.0.1', resolve)); base = 'http://127.0.0.1:3211';
}
const root = '/widgets/' + channel;
async function request(method, path, body, status = 200, token = 'widget-events-owner', headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value.data;
}
async function configure(settings, status = 200, key = crypto.randomUUID(), revision) {
  revision ??= (await request('GET', root)).revision;
  return request('POST', root + '/actions/events', settings, status, 'widget-events-owner', { 'Idempotency-Key': key, 'If-Match': String(revision) });
}
const removal = { id: 'remove-one', enabled: true, event: 'channel.bits.received', minBits: 100, maxBits: 100, action: { type: 'remove-wins', role: 'killer', amount: 1 } };
const settings = { enabled: true, active: true, allowTestEvents: false, rules: [removal] };
const definition = DOMAIN_EVENT_CONSUMERS.find(item => item.consumer === 'widget-actions-v1');
assert(definition); assert.equal(DOMAIN_EVENT_CONSUMERS.filter(item => item.consumer === definition.consumer).length, 1);
const seedWins = async () => svc.WidgetChannel.updateOne({ _id: channel }, { $set: { 'state.wins': { killer: 3, survivor: 4 } }, $inc: { revision: 1 } });
async function makeEvent(bits = 100, source = 'twitch-eventsub', timestamp = new Date(), target = channel) {
  const input = normalizeTwitchEventsubDomainEvent({ messageId: crypto.randomUUID(), messageTimestamp: timestamp.toISOString(),
    subscription: { type: 'channel.bits.use', version: '1' }, event: { broadcaster_user_id: target, user_id: '991903', bits }, source });
  return (await journalDomainEvent(input)).event;
}
async function deliver(event, expected = 'succeeded') {
  if (process.env.SAAS_TARGET === 'api') {
    await dispatchDomainEvents([definition], 100);
    await drainDomainEvents({ ...definition, batchSize: 100 });
  }
  for (let n = 0; n < 150; n++) {
    const delivery = await DomainEventDeliverySchema.findOne({ consumer: definition.consumer, eventKey: event.eventKey }).lean();
    if (delivery?.status === expected) return;
    if (delivery?.status === 'dead') assert.fail('Consumer failed: ' + delivery.lastError);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('Widget event was not delivered through the running pipeline');
}
const readWins = async () => (await svc.WidgetChannel.findById(channel).lean()).state.wins;
await request('GET', root + '/events', undefined, 401, '');
await request('GET', root + '/events', undefined, 403, 'widget-events-other');
const defaults = await request('GET', root + '/events');
assert.equal(defaults.settings.enabled, false); assert.equal(defaults.settings.active, false);
await seedWins();
await configure({ ...settings, active: false });
assert.deepEqual(await svc.activeWidgetEventTargets(channel), []);
const inactive = await makeEvent(); await deliver(inactive); assert.deepEqual(await readWins(), { killer: 3, survivor: 4 });
await configure({ ...settings, enabled: false });
const disabled = await makeEvent(); await deliver(disabled); assert.equal((await readWins()).killer, 3);
await configure(settings);
await applyWidgetDomainEvent(inactive); assert.equal((await readWins()).killer, 3, 'activation never catches up historical effects');
const injected = await makeEvent(100, 'twitch-eventsub-test'); await deliver(injected);
assert.equal((await readWins()).killer, 3, 'test events are opt-in');
const exact = await makeEvent(); await deliver(exact);
assert.deepEqual(await readWins(), { killer: 2, survivor: 4 });
await Promise.all(Array.from({ length: 20 }, () => applyWidgetDomainEvent(exact)));
assert.equal((await readWins()).killer, 2, 'repeated receipts cannot apply again');
const miss = await makeEvent(101); await deliver(miss); assert.equal((await readWins()).killer, 2);
const stale = await makeEvent(100, 'twitch-eventsub', new Date(Date.now() - 6 * 60_000)); await deliver(stale, 'skipped');
assert.equal((await readWins()).killer, 2);
await configure({ ...settings, allowTestEvents: true });
const acceptedTest = await makeEvent(100, 'twitch-eventsub-test'); await deliver(acceptedTest);
assert.equal((await readWins()).killer, 1, 'opted-in injection uses the same server rules');
await seedWins();
const concurrent = await makeEvent();
await Promise.all(Array.from({ length: 20 }, () => applyWidgetDomainEvent(concurrent)));
await deliver(concurrent); assert.equal((await readWins()).killer, 2, 'concurrent writes apply once');
// A fresh process sees the persisted receipt, rather than an in-memory dedupe cache.
execFileSync(process.execPath, ['--input-type=module', '-e', `
  const event = JSON.parse(process.argv[1]);
  for (const field of ['occurredAt','journaledAt','expiresAt']) event[field] = new Date(event[field]);
  await (await import('/app/dist/widgets/events.js')).applyWidgetDomainEvent(event);
  await (await import('mongoose')).default.disconnect();
`, JSON.stringify(concurrent)], { timeout: 30_000, stdio: 'inherit' });
assert.equal((await readWins()).killer, 2);
// Deactivation races the effect write. CAS fails and reload must stop before re-evaluation.
const race = { ...concurrent, eventKey: 'race-' + crypto.randomUUID() };
const originalUpdate = svc.WidgetChannel.updateOne;
let intercepted = false;
svc.WidgetChannel.updateOne = function(filter, update, ...args) {
  if (!intercepted && update.$set?.eventReceipts) {
    intercepted = true;
    return (async () => {
      await originalUpdate.call(this, { _id: channel }, { $set: { 'eventSettings.active': false }, $inc: { revision: 1 } });
      return originalUpdate.call(this, filter, update, ...args);
    })();
  }
  return originalUpdate.call(this, filter, update, ...args);
};
try { await applyWidgetDomainEvent(race); } finally { svc.WidgetChannel.updateOne = originalUpdate; }
assert(intercepted); assert.equal((await readWins()).killer, 2);
await configure(settings);
const token = (await request('POST', root + '/overlay-token', {})).token;
await request('GET', root + '/events', undefined, 401, token);
const observed = [], ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
ws.addEventListener('message', message => {
  const packet = String(message.data);
  if (packet.startsWith('0')) ws.send('40/overlays/widgets/' + channel + ',' + JSON.stringify({ token }));
  else if (packet === '2') ws.send('3');
  else if (packet.includes('widgets-state')) observed.push(JSON.parse(packet.slice(packet.indexOf(',') + 1))[1]);
});
async function waitState(predicate) {
  for (let n = 0; n < 150; n++) { const found = observed.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('OBS did not receive updated widget state');
}
await waitState(state => state.wins.killer === 2);
const change = await makeEvent(); await deliver(change);
const rendered = await waitState(state => state.wins.killer === 1);
assert.equal(rendered.eventSettings, undefined); assert.equal(rendered.eventReceipts, undefined); ws.close();
// Config is owner-only, validated, revision guarded and idempotent.
await configure({ ...settings, activeSince: 0 }, 400);
await configure({ ...settings, rules: [{ ...removal, action: { type: 'eval', role: 'both' } }] }, 400);
await configure(settings, 409, crypto.randomUUID(), 0);
const rev = (await request('GET', root)).revision, key = crypto.randomUUID();
await configure(settings, 200, key, rev);
const boundary = (await request('GET', root + '/events')).settings.activeSince;
await configure(settings, 200, key, rev);
assert.equal((await request('GET', root + '/events')).settings.activeSince, boundary, 'retries preserve activation boundary');
await configure({ ...settings, rules: [
  { ...removal, id: 'target', minBits: 500, maxBits: 500, action: { type: 'set-win-target', role: 'survivor', amount: 8 } },
  { ...removal, id: 'reset', minBits: 1000, maxBits: null, action: { type: 'reset-wins', role: 'both' } }
] });
await seedWins(); const targetChange = await makeEvent(500); await deliver(targetChange);
assert.equal((await svc.WidgetChannel.findById(channel).lean()).state.config.targets.survivor, 8);
const reset = await makeEvent(1000); await deliver(reset); assert.deepEqual(await readWins(), { killer: 0, survivor: 0 });
await seedWins(); await Users.updateOne({ 'accounts.id': channel }, { $set: { plan_tier: 'free' } });
const downgraded = await makeEvent(1000); await deliver(downgraded); assert.equal((await readWins()).killer, 3);
await request('GET', root + '/events', undefined, 403);
assert.equal(await svc.WidgetChannel.exists({ _id: '991999' }), null);
await applyWidgetDomainEvent({ ...reset, channelID: '991999' });
assert.equal(await svc.WidgetChannel.exists({ _id: '991999' }), null, 'events never create widget documents');
// General routing: widget B is inactive and never evaluates its rules, alongside 100 active targets.
let evaluations = 0;
await createWidgetEventHandler([{ id: 'generic-game', eventTypes: [reset.type], targets: async () => [
  ...Array.from({ length: 100 }, (_, n) => ({ id: 'a-' + n, enabled: true, active: true, activeSince: 0, allowTestEvents: false })),
  { id: 'game-b', enabled: true, active: false, activeSince: 0, allowTestEvents: false }
], apply: async target => { assert.notEqual(target.id, 'game-b'); evaluations++; } }])(reset);
assert.equal(evaluations, 100);
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test',
  '/app/dist/widgets/events.test.js', '/app/dist/widgets/event-model.test.js', '/app/dist/widgets/model.test.js',
  '/app/dist/domain_events/domain_event_consumers.test.js', '/app/dist/domain_events/domain_event_producers.test.js'], { stdio: 'inherit', timeout: 30_000 });
console.log('PASS widget events: shared stateless routing, 100 targets, inactive/disabled gates, no historical catch-up, explicit injection opt-in, atomic receipts, concurrent/restart dedupe, deactivation race, owner-only API, revision/idempotency, exact bits/ranges, win actions, entitlements, OBS state updates');
io?.close(); localServer?.close(); process.exit(0);
