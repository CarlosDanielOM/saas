/** Real configured producer acceptance in an exact bot/cron candidate.
 * Real signed chat -> command handler -> admission, and journal/dispatch/drain -> configured EventSub -> admission.
 * Disposable Mongo/Redis only. The API is an explicitly started child; outbound Twitch/LLM/TTS/Polar remain mocked.
 * Lease/election, PCM fixture and usage assertions follow the verified pet-runtime check.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
const require = createRequire('/app/package.json');
const { WebSocket } = require('ws');
const { GridFSBucket, ObjectId } = require('mongodb');
assert.equal(process.env.MONGO_URI, 'mongodb://mongo:27017/saas_ops_pet_producer_test');
assert.ok(['bot', 'cron'].includes(process.env.SAAS_TARGET));
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { PetRequest, PetRuntime } = await import('/app/dist/schemas/pet_runtime.schema.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { defaultPetSettings } = await import('/app/dist/server/services/pet_settings.service.js');
const { CommandsSchema } = await import('/app/dist/schemas/commands.schema.js');
const { ChannelModerationSettingsSchema } = await import('/app/dist/schemas/channel_moderation_settings.schema.js');
const { default: EventsubSchema } = await import('/app/dist/schemas/eventsub.schema.js');
const { DomainEventSchema } = await import('/app/dist/schemas/domain_event.schema.js');
const { DomainEventDeliverySchema } = await import('/app/dist/schemas/domain_event_delivery.schema.js');
const { DOMAIN_EVENT_CONSUMERS } = await import('/app/dist/domain_events/domain_event_consumers.js');
const { dispatchDomainEvents, drainDomainEvents } = await import('/app/dist/utils/domain_event_consumer.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const mongo = await getMongoDBConnection('pet-configured-trigger-check');
const redis = await getDragonflyClient('pet-configured-trigger-check');
const owner = '99003101', login = 'pet_owner', viewer = '99003103';
const base = 'http://127.0.0.1:3000';
const consumer = DOMAIN_EVENT_CONSUMERS.find(item => item.consumer === 'chat-announcements-v1');
assert.ok(consumer);
let api, apiExit, webhook, ws, renewal, client, renewalError;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(40); }
  throw new Error(`Timed out: ${label}; API log /tmp/pet-configured-api.log`);
}
const entries = async key => (await redis.lRange(key, 0, -1)).map(JSON.parse);
async function evidence() {
  const credits = JSON.parse(await redis.get(`twitch:${owner}:ai:credits`));
  return { providers: await entries('pet:test:provider-calls'), billing: await entries('pet:test:billing-events'),
    used: credits.used, balance: credits.balance, requestCount: await PetRequest.countDocuments() };
}
const identity = request => ({ requestId: request._id, channelId: request.channelId, origin: request.origin,
  actionKey: request.actionKey, actor: request.actor, operation: request.operation, text: request.text, payloadHash: request.payloadHash });
async function call(path, { method = 'GET', body, token = 'pet-owner-token' } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.error, false, JSON.stringify(result));
  return result.data;
}
async function connectPlayer(capability) {
  ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  const events = [], acks = new Map(); let sequence = 0, joined = false, failure;
  ws.on('error', error => { failure = error; });
  ws.on('message', raw => {
    const message = raw.toString();
    if (message === '2') return ws.send('3');
    if (message.startsWith('0')) return ws.send(`40/pet,${JSON.stringify({ v: 1, capability })}`);
    if (message.startsWith('40/pet,')) joined = true;
    if (message.startsWith('44/pet,')) failure = new Error(`Browser fixture rejected: ${message}`);
    if (message.startsWith('42/pet,')) { const [event, data] = JSON.parse(message.slice(7)); events.push({ event, data }); }
    if (message.startsWith('43/pet,')) {
      const rest = message.slice(7), bracket = rest.indexOf('['), id = Number(rest.slice(0, bracket));
      acks.get(id)?.(JSON.parse(rest.slice(bracket))[0]); acks.delete(id);
    }
  });
  await once(ws, 'open'); await until(() => joined || failure, 'browser namespace authentication'); assert.ifError(failure);
  const player = {
    events, lease: null,
    send(event, data) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { acks.delete(id); reject(new Error(`Missing ack ${event}`)); }, 5000);
        acks.set(id, value => { clearTimeout(timer); resolve(value); }); ws.send(`42/pet,${id}${JSON.stringify([event, data])}`);
      });
    },
    event(event, predicate = () => true) { return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event); }
  };
  await player.event('pet:snapshot');
  assert.equal((await player.send('pet:ready', { v: 1, audioReady: true, renderReady: true, vtsReady: false })).ok, true);
  const elected = await player.send('pet:lease', { v: 1, action: 'acquire' });
  assert.equal(elected.ok, true, JSON.stringify(elected)); player.lease = elected.data;
  renewal = setInterval(() => { if (!player.lease || ws.readyState !== WebSocket.OPEN) return;
    void player.send('pet:lease', { v: 1, action: 'renew', leaseId: player.lease.leaseId, generation: player.lease.generation })
      .then(ack => { assert.equal(ack.ok, true, JSON.stringify(ack)); player.lease = ack.data; })
      .catch(error => { renewalError = error; });
  }, 5000); renewal.unref();
  return player;
}
async function complete(request) {
  const play = await client.event('pet:play', data => data.requestId === request._id);
  const index = client.events.findIndex(item => item.event === 'pet:play' && item.data.requestId === request._id);
  assert.equal(client.events[index - 1]?.event, 'pet:request');
  assert.equal(client.events[index - 1]?.data.request.status, 'ready');
  const progress = { v: 1, requestId: request._id, leaseId: play.leaseId, generation: play.generation, positionMs: 0 };
  assert.equal((await client.send('pet:playback', { ...progress, seq: 0, phase: 'started' })).ok, true);
  assert.equal((await client.send('pet:playback', { ...progress, seq: 1, phase: 'ended', positionMs: 500 })).ok, true);
  await until(() => PetRequest.findOne({ _id: request._id, status: 'completed' }).lean(), 'terminal request');
  await until(() => PetRuntime.findOne({ activeRequestId: null, channelId: owner }).lean(), 'free pet slot');
  assert.equal(client.events.filter(item => item.event === 'pet:play' && item.data.requestId === request._id).length, 1);
}
let webhookURL;
async function notify(type, event, { messageId = randomUUID(), timestamp = new Date().toISOString(), signature } = {}) {
  const body = JSON.stringify({ subscription: { id: `fixture-${type}`, type, version: type === 'channel.follow' ? '2' : '1',
    condition: { broadcaster_user_id: owner } }, event });
  const expected = `sha256=${createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET).update(messageId).update(timestamp).update(body).digest('hex')}`;
  const response = await fetch(webhookURL, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'Twitch-Eventsub-Message-Id': messageId, 'Twitch-Eventsub-Message-Timestamp': timestamp,
    'Twitch-Eventsub-Message-Signature': signature || expected, 'Twitch-Eventsub-Message-Type': 'notification' }, body });
  return { status: response.status, messageId, timestamp };
}
const broadcaster = { broadcaster_user_id: owner, broadcaster_user_login: login, broadcaster_user_name: 'Pet owner' };
const chat = text => ({ ...broadcaster, chatter_user_id: viewer, chatter_user_login: 'pet_viewer', chatter_user_name: 'Pet viewer',
  message_id: randomUUID(), badges: [], message: { text, fragments: [{ type: 'text', text }] }, color: '#ffffff', message_type: 'text',
  cheer: null, reply: null, channel_points_custom_reward_id: null });
const requestFor = (kind, id) => until(() => PetRequest.findOne({ 'origin.kind': kind, 'origin.id': id }).lean(), `admission ${id}`);
async function drain() { await dispatchDomainEvents([consumer]); return drainDomainEvents(consumer); }

try {
  // Same default configuration, private GIF and browser ready/election setup as pet-runtime.mjs.
  const inserted = await mongo.connection.db.collection('users').insertOne({ name: 'Pet owner', plan_tier: 'premium',
    polar_sh_customer_id: 'pet-test-customer', accounts: [{ type: 'twitch', id: owner, name: login }] });
  const ownerId = String(inserted.insertedId);
  await redis.hSet(`accounts:twitch:${owner}:data`, { id: owner, name: login, plan_tier: 'premium', chat_enabled: 'true',
    actived: 'true', has_permissions: 'true', refresh_token: 'fixture-not-a-real-token' });
  await redis.hSet('token:pet-owner-token', { id: owner, login, display_name: 'Pet owner' });
  await redis.set('app:twitch:token', 'fixture-app-token');
  await redis.set(`twitch:${owner}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
    used: 0, limit: 100, balance: 100, available: true, status: 'available', updatedAt: new Date().toISOString() }));
  await ChannelModerationSettingsSchema.create({ channelID: owner, channel: login, enabled: false });
  const assetId = new ObjectId(), gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const upload = new GridFSBucket(mongo.connection.db, { bucketName: 'private_assets' })
    .openUploadStreamWithId(assetId, 'pet.gif', { metadata: { owner, mime: 'image/gif' } });
  const stored = once(upload, 'finish'); upload.end(gif); await stored;
  await mongo.connection.db.collection('asset_libraries').insertOne({ _id: owner, usedBytes: gif.length,
    assets: [{ id: String(assetId), name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: gif.length,
      width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] });
  const settings = defaultPetSettings(); settings.enabled = true; settings.behavior.cooldownSeconds = 0;
  settings.appearance = { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) };
  await PetSettingsSchema.create({ userId: inserted.insertedId, settings, revision: 1, updatedAt: new Date() });
  await CommandsSchema.create([
    { channelID: owner, channel: login, name: 'Pet talk', cmd: 'pettalk', func: 'custom', message: '$(pet.talk &t)', cooldown: 0, userLevel: 1 },
    { channelID: owner, channel: login, name: 'Pet ask', cmd: 'petask', func: 'custom', message: '$(pet.ask &t)', cooldown: 0, userLevel: 1 },
    { channelID: owner, channel: login, name: 'Pet reference', cmd: 'petreference', func: 'custom', message: '#(pettalk &t)', cooldown: 0, userLevel: 1 },
    { channelID: owner, channel: login, name: 'Denied pet', cmd: 'petdenied', func: 'custom', message: '$(pet.talk forbidden)', cooldown: 0,
      userLevel: 1, permissionExpression: { role: 'mod' } }
  ]);
  for (const type of ['channel.bits.use', 'channel.follow']) await EventsubSchema.create({
    id: `fixture-${type}`, type, version: type === 'channel.follow' ? '2' : '1', enabled: true, channelID: owner, channel: login,
    status: 'enabled', condition: { broadcaster_user_id: owner }, created_at: new Date().toISOString(), cost: 0,
    transport: { method: 'webhook', callback: 'http://127.0.0.1/eventsub' }, cheerTiers: [],
    message: type === 'channel.bits.use' ? 'Thanks $(pet.talk &t)' : '$(pet.ask Thank %(user) for following)' });

  // Only this explicitly started API may perform synthesis/LLM/billing work.
  const log = openSync('/tmp/pet-configured-api.log', 'w');
  api = spawn(process.execPath, ['/app/dist/server/index.js'], { cwd: '/app',
    env: { ...process.env, PET_PRODUCER_ROLE: 'api-runtime' }, stdio: ['ignore', log, log] });
  closeSync(log); apiExit = once(api, 'exit');
  await until(async () => { assert.equal(api.exitCode, null, 'API child stays alive');
    try { return (await fetch(base + '/pets/' + owner + '/settings', { headers: { Authorization: 'Bearer pet-owner-token' } })).ok; }
    catch { return false; } }, 'explicit API child ready');
  const capability = (await call(`/pets/${owner}/overlay-token`, { method: 'POST', body: {} })).token;
  client = await connectPlayer(capability);
  const persisted = await PetRuntime.findById(ownerId).lean();
  assert.equal(persisted.lease.leaseId, client.lease.leaseId, 'actual elected lease persisted for separate producer');

  if (process.env.SAAS_TARGET === 'bot') {
    webhookURL = 'http://127.0.0.1:3333/eventsub';
    await until(async () => { try { return (await fetch(webhookURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403; }
      catch { return false; } }, 'normal bot webhook ready');
  } else {
    // Cron packages the same ingress/command modules; no duplicate bot is running in this candidate.
    const { createTwitchEventsubApp } = await import('/app/dist/bot/eventsub.twitch.js');
    webhook = createTwitchEventsubApp().listen(0); await once(webhook, 'listening');
    webhookURL = `http://127.0.0.1:${webhook.address().port}/eventsub`;
  }
  const negative = chat('!pettalk forbidden');
  assert.equal((await notify('channel.chat.message', negative, { signature: 'sha256=invalid' })).status, 403);
  assert.equal((await notify('channel.chat.message', negative, { timestamp: new Date(Date.now() - 20 * 60_000).toISOString() })).status, 403);
  assert.equal(await PetRequest.countDocuments(), 0, 'bad signature/stale signed chat cannot admit');

  const injected = 'Hello $(pet.ask viewer-injection)', direct = chat(`!pettalk ${injected}`);
  const directReceipt = { messageId: randomUUID(), timestamp: new Date().toISOString() };
  assert.equal((await notify('channel.chat.message', direct, directReceipt)).status, 204);
  const spoken = await requestFor('chat-command', direct.message_id); await complete(spoken);
  assert.equal(spoken.operation, 'talk'); assert.equal(spoken.text, injected);
  assert.equal(spoken.origin.occurredAt, directReceipt.timestamp);
  const spokenIdentity = identity(await PetRequest.findById(spoken._id).lean()), spokenEvidence = await evidence();
  assert.equal(spokenEvidence.providers.filter(item => item.kind === 'llm').length, 0, 'talk does not invoke an LLM');
  assert.equal(spokenEvidence.providers.filter(item => item.kind === 'tts').length, 1);
  assert.deepEqual(spokenEvidence.billing.map(item => item.external_id), [`${spoken._id}:tts`]);
  assert.ok(spokenEvidence.used > 0, 'real usage path applies the local debit');
  assert.equal((await notify('channel.chat.message', direct, directReceipt)).status, 204);
  assert.deepEqual(identity(await PetRequest.findById(spoken._id).lean()), spokenIdentity);
  assert.deepEqual(await evidence(), spokenEvidence, 'duplicate signed command leaves request/providers/debit unchanged');

  assert.equal((await notify('channel.chat.message', chat('!petdenied denied'))).status, 204);
  const prompt = chat('!petask Say something friendly');
  assert.equal((await notify('channel.chat.message', prompt)).status, 204);
  const asked = await requestFor('chat-command', prompt.message_id); await complete(asked);
  const afterAsk = await evidence();
  assert.equal(afterAsk.providers.filter(item => item.kind === 'llm').length, 1);
  assert.deepEqual(afterAsk.providers.find(item => item.kind === 'llm').body.tools, []);
  assert.ok(afterAsk.providers.some(item => item.kind === 'tts' && item.body.text.includes('$(pet.talk generated-injection)')));
  for (const phase of ['llm', 'tts']) assert.equal(afterAsk.billing.filter(item => item.external_id === `${asked._id}:${phase}`).length, 1);
  assert.equal(afterAsk.requestCount, 2, 'denied command and generated/user injection cannot create requests');

  const referenced = chat('!petreference Nested literal $(pet.ask no-reparse)');
  assert.equal((await notify('channel.chat.message', referenced)).status, 204);
  const nested = await requestFor('chat-command', referenced.message_id); await complete(nested);
  assert.equal(nested.operation, 'talk'); assert.equal(nested.text, 'Nested literal $(pet.ask no-reparse)');
  assert.equal((await evidence()).providers.filter(item => item.kind === 'llm').length, 1,
    'reference-only outer response still delivers the configured pet command with literal arguments');

  // Genuine signed EventSub journals; the real registered durable consumer reads stored config.
  const bits = { ...broadcaster, user_id: viewer, user_login: 'pet_viewer', user_name: 'Pet viewer', bits: 100,
    is_anonymous: false, message: 'Bits literal $(pet.ask never-evaluate)' };
  const bitsReceipt = { messageId: randomUUID(), timestamp: new Date().toISOString() };
  assert.equal((await notify('channel.bits.use', bits, bitsReceipt)).status, 204);
  const bitsEvent = await until(() => DomainEventSchema.findOne({ sourceEventId: bitsReceipt.messageId }).lean(), 'durable bits journal');
  assert.equal(await PetRequest.countDocuments(), 3, 'immediate bot path does not duplicate durable event effects');
  await redis.set('pet:producer:fail-chat', '1');
  assert.equal((await drain()).retried, 1, 'chat failure retains durable delivery after real admission');
  const bitsRequest = await requestFor('twitch-event', bitsEvent.eventKey); await complete(bitsRequest);
  assert.equal(bitsRequest.text, bits.message); assert.equal(bitsRequest.origin.occurredAt, bitsEvent.occurredAt.toISOString());
  const bitsIdentity = identity(await PetRequest.findById(bitsRequest._id).lean()), bitsEvidence = await evidence();
  assert.equal(bitsEvidence.providers.filter(item => item.kind === 'llm').length, 1, 'configured bits talk also skips the LLM');
  await redis.del('pet:producer:fail-chat');
  await DomainEventDeliverySchema.updateOne({ consumer: consumer.consumer, eventKey: bitsEvent.eventKey, status: 'retry' }, { $set: { nextAttemptAt: new Date(0) } });
  assert.equal((await drain()).succeeded, 1);
  assert.deepEqual(identity(await PetRequest.findById(bitsRequest._id).lean()), bitsIdentity);
  assert.deepEqual(await evidence(), bitsEvidence, 'durable retry keeps the same request, full identity, providers and debit');
  assert.equal((await notify('channel.bits.use', bits, bitsReceipt)).status, 204);
  assert.equal(await DomainEventSchema.countDocuments({ sourceEventId: bitsReceipt.messageId }), 1);
  await drain(); assert.deepEqual(await evidence(), bitsEvidence);

  const follow = { ...broadcaster, user_id: viewer, user_login: 'pet_viewer', user_name: 'Pet viewer', followed_at: new Date().toISOString() };
  const followReceipt = { messageId: randomUUID(), timestamp: new Date().toISOString() };
  assert.equal((await notify('channel.follow', follow, followReceipt)).status, 204);
  const followEvent = await until(() => DomainEventSchema.findOne({ sourceEventId: followReceipt.messageId }).lean(), 'durable follow journal');
  const beforeFollowChat = await redis.lLen('pet:producer:chat-attempts');
  await redis.del('app:twitch:token');
  assert.equal((await drain()).succeeded, 1);
  const followRequest = await requestFor('twitch-event', followEvent.eventKey); await complete(followRequest);
  assert.equal(followRequest.operation, 'ask'); assert.equal(followRequest.origin.occurredAt, follow.followed_at);
  assert.equal(await redis.lLen('pet:producer:chat-attempts'), beforeFollowChat, 'pet-only event sends no empty Twitch chat message');
  const followIdentity = identity(await PetRequest.findById(followRequest._id).lean()), followEvidence = await evidence();
  await consumer.handler(followEvent); // Simulate duplicate delivery after external acceptance/ack loss.
  assert.deepEqual(identity(await PetRequest.findById(followRequest._id).lean()), followIdentity);
  assert.deepEqual(await evidence(), followEvidence, 'real consumer duplicate cannot repeat request or debit');

  await EventsubSchema.updateOne({ channelID: owner, type: 'channel.follow' }, { $set: { enabled: false } });
  const disabled = await notify('channel.follow', { ...follow, followed_at: new Date().toISOString() });
  assert.equal(disabled.status, 204); assert.equal((await drain()).succeeded, 1);
  assert.deepEqual(await evidence(), followEvidence, 'disabled event never reaches real admission/providers/debit');
  assert.equal(await PetRequest.countDocuments(), 5);
  assert.ifError(renewalError);
  assert.equal(followEvidence.providers.filter(item => item.kind === 'tts').length, 5);
  assert.equal(followEvidence.providers.filter(item => item.kind === 'llm').length, 2);
  assert.equal(followEvidence.billing.length, 7);
  assert.equal(new Set(followEvidence.billing.map(item => item.external_id)).size, 7);
  assert.ok(followEvidence.billing.every(item => item.metadata.usage_source === 'pet'));
  const outbound = await entries('pet:producer:outbound');
  assert.ok(outbound.length > 0);
  assert.ok(outbound.every(item => item.role === 'api-runtime'), 'bot/cron/check only admit; paid outbound runs in explicit API child');
} finally {
  clearInterval(renewal);
  if (ws) ws.terminate();
  if (webhook) await new Promise(resolve => webhook.close(resolve));
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    const timeout = setTimeout(() => api.kill('SIGKILL'), 5000); timeout.unref();
    await apiExit; clearTimeout(timeout);
  }
  const { shutdownPosthog } = await import('/app/dist/utils/posthog_events.js');
  await shutdownPosthog();
  await globalThis.closePetProducerFixture?.();
  if (redis.isOpen) redis.destroy();
  await mongo.disconnect();
}
console.log(`PASS ${process.env.SAAS_TARGET}: real signed configured commands, durable bits/follows, one request/debit on retry, direct talk zero LLM, literal injection and permission/enabled gates`);
