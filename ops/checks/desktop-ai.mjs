/** Exact API candidate only: disposable Mongo/Redis, mocked providers and writes. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const { WebSocket } = createRequire('/app/package.json')('ws');
const { GridFSBucket, ObjectId } = createRequire('/app/package.json')('mongodb');
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/);
assert.equal(process.env.PIPER_HTTP_URL, 'http://pet-piper.test');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { AI_CREDITS_CACHE_SCHEMA_VERSION } = await import('/app/dist/utils/billing.js');
const { default: TwitchStreamers } = await import('/app/dist/classes/twitch_streamers.class.js');
const mongo = await getMongoDBConnection('desktop-ai-check');
const redis = await getDragonflyClient('desktop-ai-check');
const db = mongo.connection.db, base = 'http://127.0.0.1:3000', owner = '99003101', other = '99003102';
const inserted = await db.collection('users').insertMany([
  { name: 'OAuth Owner', plan_tier: 'premium', polar_sh_customer_id: 'desktop-fixture-customer',
    accounts: [{ type: 'twitch', id: owner, name: 'oauth_owner', has_permissions: true }] },
  { name: 'OAuth Other', plan_tier: 'premium', accounts: [{ type: 'twitch', id: other, name: 'oauth_other' }] }
]);
const ownerId = String(inserted.insertedIds[0]);
await redis.hSet('token:pet-owner-token', { id: owner, login: 'oauth_owner', display_name: 'OAuth Owner' });
await TwitchStreamers.getTwitchAccountsFromDB();
await redis.set('app:twitch:token', 'fixture-app-token');
await redis.hSet(`accounts:twitch:${owner}:data`, { has_permissions: 'true', access_token: 'fixture-owner-token',
  expires_at: String(Math.floor(Date.now() / 1000) + 3600) });
for (const id of [owner, other]) await redis.set(`twitch:${id}:ai:credits`, JSON.stringify({ version: AI_CREDITS_CACHE_SCHEMA_VERSION,
  used: 0, limit: 100, balance: 100, available: true, status: 'available', updatedAt: new Date().toISOString() }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
async function call(path, token, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  assert.ok(Buffer.byteLength(raw) <= 32768, `${path}: response exceeds app JSON cap`);
  return { status: response.status, headers: response.headers, body: response.status === 302 ? null : JSON.parse(raw) };
}
const seven = 'profile:read credits:read desktop:connect pet:read pet:receive pet:control pet:playback:select';
async function mint(scope, browser = 'oauth-beta-browser-owner') {
  const verifier = randomBytes(32).toString('base64url');
  const start = await call('/oauth/authorize?' + new URLSearchParams({ client_id: 'dima-desktop', response_type: 'code', scope,
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback', state: verifier,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }));
  assert.equal(start.status, 302);
  const request = new URL(start.headers.get('location')).searchParams.get('request');
  const decision = await call(`/oauth/requests/${request}/decision`, browser, 'POST', { approve: true });
  assert.equal(decision.status, 200);
  const result = await call('/oauth/token', undefined, 'POST', { client_id: 'dima-desktop', grant_type: 'authorization_code',
    code: new URL(decision.body.redirect_uri).searchParams.get('code'), code_verifier: verifier,
    redirect_uri: 'http://127.0.0.1:42781/oauth/callback' });
  assert.equal(result.status, 200); return result.body;
}
const legacy = await mint(seven), full = await mint(`${seven} ai:interact pet:interact`);
const second = await mint(`${seven} ai:interact pet:interact`);
const foreign = await mint(`${seven} ai:interact pet:interact`, 'oauth-beta-browser-other');
const token = full.access_token;
const turns = '/v1/me/ai/turns';
const payload = (extra = {}) => ({ request_id: randomUUID(), target: 'bot', text: 'Hey Dima, how are you?', source: 'asr', silent: true, ...extra });
const submit = input => call(turns, token, 'POST', input);
const read = id => call(`${turns}/${id}`, token);
async function settled(id) {
  return until(async () => { const r = await read(id); assert.equal(r.status, 200);
    return ['completed', 'failed', 'cancelled', 'indeterminate'].includes(r.body.status) ? r.body : null; }, 'turn settles');
}
function successful(snapshot) { assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot)); return snapshot; }
let groups = 0;
let r = await call('/v1/me/ai/capabilities', legacy.access_token);
assert.equal(r.status, 200); assert.equal(r.body.permission_profile_version, 2);
assert.deepEqual(r.body.features, ['turn-status-v1'], 'capabilities advertises optional socket feature before opt-in');
const advertisedFeatures = r.body.features;
assert.deepEqual(r.body.required_scopes, { bot: ['ai:interact'], pet: ['pet:interact'] });
assert.ok(r.body.supported_scopes.includes('ai:interact') && r.body.supported_scopes.includes('pet:interact'));
assert.deepEqual([...r.body.granted_scopes].sort(), seven.split(' ').sort());
assert.equal((await call(turns, legacy.access_token, 'POST', payload())).status, 403);
assert.equal((await call(turns, undefined, 'POST', payload())).status, 401); groups++;

for (const bad of [payload({ silent: undefined }), payload({ text: ' \n ' }), payload({ text: '😀'.repeat(1001) }),
  payload({ actor: owner }), payload({ userlevel: 10 }), payload({ channel_id: other }), payload({ target: 'admin' }),
  payload({ source: 'streamer' }), payload({ conversation_id: 'forged' })]) {
  const result = await submit(bad); assert.ok([400, 404].includes(result.status), JSON.stringify(result));
}
const acceptedBoundary = await submit(payload({ text: '😀'.repeat(1000) }));
assert.equal(acceptedBoundary.status, 202); successful(await settled(acceptedBoundary.body.turn_id)); groups++;

// The server accepts conversation, not only command-shaped text, and preserves raw input.
const original = payload({ text: '  Hey Dima, how are you? Actually, tell me what chat is doing.  ' });
const callsBefore = await redis.lLen('desktop:test:llm');
const ttsBeforeSilent = (await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts').length;
const admissions = await Promise.all(Array.from({ length: 6 }, () => submit(original)));
assert.ok(admissions.every(item => item.status === 202));
assert.equal(new Set(admissions.map(item => item.body.turn_id)).size, 1);
const first = admissions[0].body, done = successful(await settled(first.turn_id));
assert.ok(done.revision > first.revision); assert.ok(done.reply_text.length > 0 && done.reply_text.length <= 500);
assert.ok(!done.speech, 'silent has no TTS descriptor');
assert.equal((await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts').length,
  ttsBeforeSilent, 'silent conversation never invokes the TTS provider');
assert.equal(await redis.lLen('desktop:test:llm'), callsBefore + 1, 'concurrent admission generates once');
r = await call(`${turns}/by-request/${original.request_id}`, token);
assert.equal(r.body.turn_id, first.turn_id); assert.equal(r.body.reply_text, done.reply_text);
assert.equal((await submit({ ...original, silent: false })).status, 409);
assert.equal((await submit({ ...original, text: original.text.trim() })).status, 409);
assert.equal((await call(`${turns}/${first.turn_id}`, foreign.access_token)).status, 404);
const sameOwnerAfterRefresh = await call('/oauth/token', undefined, 'POST', { client_id: 'dima-desktop',
  grant_type: 'refresh_token', refresh_token: full.refresh_token });
assert.equal(sameOwnerAfterRefresh.status, 200);
assert.equal((await call(`${turns}/by-request/${original.request_id}`, sameOwnerAfterRefresh.body.access_token)).body.turn_id, first.turn_id);
assert.equal((await call(`${turns}/by-request/${original.request_id}`, second.access_token)).body.turn_id, first.turn_id,
  'turn admission survives a new session for the same owner/client');
const follow = await submit(payload({ text: 'What did I just ask?', conversation_id: first.conversation_id }));
assert.equal(follow.status, 202); successful(await settled(follow.body.turn_id));
const prompt = JSON.parse((await redis.lRange('desktop:test:llm', -1, -1))[0]);
assert.ok(JSON.stringify(prompt.messages).includes(original.text.trim()), 'desktop follow-up includes thread history');
const invalidConversation = await submit(payload({ target: 'pet', conversation_id: first.conversation_id }));
assert.equal(invalidConversation.status, 400);
assert.equal(invalidConversation.body.error, 'invalid_conversation');
groups++;

const sockets = [];
async function connect(namespace, accessToken, acknowledge = true, features) {
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws); const events = [], acknowledgements = new Map(); let joined = false, failed, sequence = 0;
  ws.on('message', raw => {
    const message = raw.toString();
    if (message === '2') return ws.send('3');
    if (message.startsWith('0')) return ws.send(`40${namespace},${JSON.stringify({ v: 1, accessToken, ...(features ? { features } : {}) })}`);
    if (message.startsWith(`40${namespace},`)) joined = true;
    if (message.startsWith(`44${namespace},`)) failed = message;
    if (message.startsWith(`43${namespace},`)) {
      const rest = message.slice(`43${namespace},`.length), bracket = rest.indexOf('[');
      acknowledgements.get(Number(rest.slice(0, bracket)))?.(JSON.parse(rest.slice(bracket))[0]);
      acknowledgements.delete(Number(rest.slice(0, bracket))); return;
    }
    if (!message.startsWith(`42${namespace},`)) return;
    const rest = message.slice(`42${namespace},`.length), bracket = rest.indexOf('[');
    const ackID = rest.slice(0, bracket), [event, data] = JSON.parse(rest.slice(bracket));
    events.push({ event, data, ackID, at: Date.now() });
    if (event === 'speech:prepare' && acknowledge && ackID) ws.send(`43${namespace},${ackID}${JSON.stringify([{
      v: 1, playback_id: data.playback_id, output_generation: data.output_generation, paused: true }])}`);
  });
  await once(ws, 'open'); await until(() => joined || failed, `${namespace} authentication`);
  assert.ok(!failed, failed);
  return { ws, events,
    send(event, data) { const id = ++sequence; return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { acknowledgements.delete(id); reject(new Error(`Missing ${event} acknowledgement`)); }, 5000);
      acknowledgements.set(id, value => { clearTimeout(timer); resolve(value); });
      ws.send(`42${namespace},${id}${JSON.stringify([event, data])}`);
    }); },
    emit(event, data) { ws.send(`42${namespace},${JSON.stringify([event, data])}`); },
    acknowledge(event, playbackId) {
      const item = events.find(row => row.event === event && row.data?.playback_id === playbackId);
      assert.ok(item?.ackID, `missing acknowledgement id for ${event}`);
      ws.send(`43${namespace},${item.ackID}${JSON.stringify([{ v: 1, playback_id: item.data.playback_id,
        output_generation: item.data.output_generation, paused: true }])}`);
    },
    event(event, predicate = () => true, timeout = 15_000) {
      return until(() => events.find(item => item.event === event && predicate(item.data))?.data, event, timeout);
    }
  };
}
const activity = await connect('/desktop-ai', token, true, advertisedFeatures);
// The released activity parser is strict: omitted features must never receive hints.
const plainActivity = await connect('/desktop-ai', token);
await plainActivity.event('speech:snapshot');
const otherSessionActivity = await connect('/desktop-ai', second.access_token, true, ['turn-status-v1']);
await otherSessionActivity.event('speech:snapshot');
const foreignActivity = await connect('/desktop-ai', foreign.access_token, true, ['turn-status-v1']);
await foreignActivity.event('speech:snapshot');
const limitedActivity = await connect('/desktop-ai', legacy.access_token, true, ['turn-status-v1']);
await limitedActivity.event('speech:snapshot');
function assertHint(hint, snapshot) {
  assert.deepEqual(Object.keys(hint).sort(), ['request_id', 'revision', 'turn_id', 'v']);
  assert.equal(hint.v, 1); assert.equal(hint.request_id, snapshot.request_id); assert.equal(hint.turn_id, snapshot.turn_id);
  assert.ok(Number.isSafeInteger(hint.revision) && hint.revision > 0);
  assert.equal(hint.revision, snapshot.revision, 'hint uses the same wire revision as HTTP');
}
async function currentHint(snapshot) {
  return until(async () => {
    const authoritative = (await read(snapshot.turn_id)).body;
    const hint = activity.events.findLast(item => item.event === 'ai:turn-updated' && item.data.turn_id === snapshot.turn_id &&
      item.data.revision >= snapshot.revision && item.data.revision === authoritative.revision)?.data;
    if (!hint) return null;
    assertHint(hint, authoritative); return hint;
  }, 'committed hint matching current HTTP revision');
}
const activitySnapshot = await activity.event('speech:snapshot');
assert.ok(Number.isSafeInteger(activitySnapshot.server_time));
const old = await connect('/desktop', legacy.access_token);
const legacyHello = await old.event('desktop:hello');
assert.deepEqual([...legacyHello.scopes].sort(), seven.split(' ').sort());
const desktop = await connect('/desktop', token);
const fullHello = await desktop.event('desktop:hello');
assert.deepEqual([...fullHello.scopes].sort(), `${seven} ai:interact pet:interact`.split(' ').sort());
groups++;

// A ready hint can race an older HTTP result still being processed by the app.
await redis.set('desktop:test:mode', 'hold');
const racing = await submit(payload({ silent: false })); assert.equal(racing.status, 202);
const inFlightSnapshot = await fetch(base + `${turns}/${racing.body.turn_id}`, { headers: { Authorization: `Bearer ${token}` } });
assert.equal(inFlightSnapshot.status, 200);
const readyHint = await until(async () => {
  const hint = activity.events.findLast(item => item.event === 'ai:turn-updated' && item.data.turn_id === racing.body.turn_id)?.data;
  if (!hint) return null;
  const current = (await read(hint.turn_id)).body;
  return current.speech?.status === 'ready' && hint.revision === current.revision ? hint : null;
}, 'ready hint while stale HTTP snapshot is in flight');
const staleSnapshot = await inFlightSnapshot.json();
assert.ok(staleSnapshot.revision < readyHint.revision);
const afterRace = (await read(readyHint.turn_id)).body; assertHint(readyHint, afterRace);
assert.equal(afterRace.speech.status, 'ready');
assert.equal((await call(`${turns}/${afterRace.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: afterRace.speech.playback_id, output_generation: afterRace.speech.output_generation })).body.accepted, true);
await redis.del('desktop:test:mode');
// Simulate lost/ignored transport hints: bounded fallback GET still discovers
// readiness and keeps the existing one-fetch path, without submitting again.
const lostInput = payload({ silent: false }), beforeLost = await redis.lLen('desktop:test:llm');
const lost = await submit(lostInput); assert.equal(lost.status, 202);
const fallbackReady = await until(async () => {
  const value = (await read(lost.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null;
}, 'HTTP fallback without reading any hint');
assert.equal(await redis.lLen('desktop:test:llm'), beforeLost + 1);
assert.equal((await call(`${turns}/${fallbackReady.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: fallbackReady.speech.playback_id, output_generation: fallbackReady.speech.output_generation })).body.accepted, true);
groups++;

// Bot synthesis works with no pet enabled or selected, and never emits pet animation.
const voiced = await submit(payload({ silent: false })); assert.equal(voiced.status, 202);
const spoken = await until(async () => { const result = (await read(voiced.body.turn_id)).body;
  if (['failed', 'indeterminate'].includes(result.status)) throw new Error(JSON.stringify(result));
  return result.speech?.status === 'ready' ? result : null; }, 'bot audio ready');
assert.equal(spoken.speech.animate_pet, false); assert.equal(spoken.speech.transport, 'http');
assert.equal(spoken.speech.destination, 'desktop');
assert.match(spoken.speech.audio_url, /^\/v1\/me\/ai\/turns\//);
await currentHint(spoken);
const readyTTL = await redis.pTTL(`desktop-ai:ticket:${spoken.turn_id}`);
assert.ok(readyTTL > 18_000 && readyTTL <= 20_000, `ready ticket TTL ${readyTTL}`);
assert.equal(spoken.speech.start_before, spoken.speech.ticket_expires_at);
assert.ok(spoken.speech.start_before - Date.now() > 18_000 && spoken.speech.start_before - Date.now() <= 20_000);
const audioURL = base + spoken.speech.audio_url;
assert.equal((await fetch(audioURL)).status, 401);
assert.ok([401, 403].includes((await fetch(audioURL, { headers: { Authorization: `Bearer ${token}` } })).status));
assert.ok([403, 404].includes((await fetch(audioURL, { headers: { Authorization: `Bearer ${second.access_token}`,
  'X-Dima-Audio-Ticket': spoken.speech.ticket } })).status));
const audioHeaders = { Authorization: `Bearer ${token}`, 'X-Dima-Audio-Ticket': spoken.speech.ticket };
const audio = await fetch(audioURL, { headers: audioHeaders }); assert.equal(audio.status, 200);
assert.match(audio.headers.get('cache-control'), /no-store/); assert.ok((await audio.arrayBuffer()).byteLength > 44);
assert.ok([403, 409].includes((await fetch(audioURL, { headers: audioHeaders })).status), 'audio cannot be fetched twice');
const fence = { playback_id: spoken.speech.playback_id, output_generation: spoken.speech.output_generation };
const prepareEvent = await activity.event('speech:prepare', item => item.playback_id === fence.playback_id);
assert.ok(Number.isSafeInteger(prepareEvent.server_time));
assert.equal(prepareEvent.phase, 'preparing');
r = await call(`${turns}/${spoken.turn_id}/speech/events`, token, 'POST', { ...fence, event: 'started' });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.snapshot.speech.status, 'playing');
await until(() => activity.events.some(item => item.event === 'speech:started' && item.data.playback_id === fence.playback_id), 'started notification');
assert.ok(activity.events.some(item => item.event === 'speech:prepare' && item.data.playback_id === fence.playback_id));
const observer = await connect('/desktop-ai', second.access_token);
const playingSnapshot = await observer.event('speech:snapshot');
assert.ok(Number.isSafeInteger(playingSnapshot.server_time));
assert.equal(playingSnapshot.active.length, 1);
assert.equal(playingSnapshot.active[0].playback_id, fence.playback_id);
assert.equal(playingSnapshot.active[0].phase, 'playing', 'reconnecting subscriber receives current output before capture can resume');
r = await call(`${turns}/${spoken.turn_id}/speech/events`, token, 'POST', { ...fence, event: 'ended' });
assert.equal(r.status, 200); assert.equal(r.body.snapshot.speech.status, 'completed');
await until(() => activity.events.some(item => item.event === 'speech:ended' && item.data.playback_id === fence.playback_id), 'ended notification');
await observer.event('speech:ended', item => item.playback_id === fence.playback_id);
observer.ws.close();
await currentHint(r.body.snapshot);
assert.ok(activity.events.find(item => item.event === 'speech:started' && item.data.playback_id === fence.playback_id).data.revision > prepareEvent.revision);
assert.ok(!old.events.some(item => item.event.startsWith('speech:') || item.event.startsWith('ai:') || item.event === 'pet:play'));
assert.equal(await db.collection('pet_requests').countDocuments(), 0, 'Bot never enters pet.talk/read-TTS'); groups++;

assert.ok(!plainActivity.events.some(item => item.event === 'ai:turn-updated'), 'legacy activity parser receives no hint');
assert.ok(!otherSessionActivity.events.some(item => item.event === 'ai:turn-updated'), 'same owner another session receives no hint');
assert.ok(!foreignActivity.events.some(item => item.event === 'ai:turn-updated'), 'other owner receives no hint');
assert.ok(!limitedActivity.events.some(item => item.event === 'ai:turn-updated'), 'missing interaction scope receives no hint');
// Reordering/duplicates are hints only: reconciliation never replays provider work.
const hints = activity.events.filter(item => item.event === 'ai:turn-updated' && item.data.turn_id === spoken.turn_id).map(item => item.data);
const beforeHints = await redis.lLen('desktop:test:llm');
for (const hint of [...hints].reverse().concat(hints)) {
  assert.equal((await read(hint.turn_id)).body.speech.status, 'completed');
}
assert.equal(await redis.lLen('desktop:test:llm'), beforeHints);
otherSessionActivity.ws.close(); foreignActivity.ws.close(); limitedActivity.ws.close();
await until(() => otherSessionActivity.ws.readyState === WebSocket.CLOSED, 'other-session fixture closes');
groups++;

// A different authorized installation can cancel the turn while the initiating
// app is still audibly playing. Only that initiating player can prove it stopped.
const interruptedBot = await submit(payload({ silent: false, text: 'Speak until the other device cancels.' }));
assert.equal(interruptedBot.status, 202);
const interruptedReady = await until(async () => { const value = (await read(interruptedBot.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'Bot ready for cross-session cancellation');
const interruptedFence = { playback_id: interruptedReady.speech.playback_id, output_generation: interruptedReady.speech.output_generation };
const interruptedAudio = await fetch(base + interruptedReady.speech.audio_url, { headers: { Authorization: `Bearer ${token}`,
  'X-Dima-Audio-Ticket': interruptedReady.speech.ticket } });
assert.equal(interruptedAudio.status, 200); await interruptedAudio.arrayBuffer();
r = await call(`${turns}/${interruptedReady.turn_id}/speech/events`, token, 'POST', { ...interruptedFence, event: 'started' });
assert.equal(r.status, 200); assert.equal(r.body.snapshot.speech.status, 'playing');
// Give the fixture's active player a realistic long enough deadline to assert
// that a correct stop proof, rather than expiry, releases the slot.
await db.collection('desktop_ai_turns').updateOne({ _id: interruptedReady.turn_id, 'speech.status': 'playing' },
  { $set: { 'speech.playbackDeadline': new Date(Date.now() + 12_000) } });
const crossCancel = await call(`${turns}/${interruptedReady.turn_id}/cancel`, second.access_token, 'POST', {});
assert.equal(crossCancel.status, 200); assert.equal(crossCancel.body.snapshot.speech.status, 'cancelled');
const interruptedObserver = await connect('/desktop-ai', second.access_token);
const interruptedSnapshot = await interruptedObserver.event('speech:snapshot');
assert.equal(interruptedSnapshot.active[0]?.playback_id, interruptedFence.playback_id,
  'cross-session cancellation cannot claim the initiating player is silent');
assert.ok(!activity.events.some(item => item.event === 'speech:ended' && item.data.playback_id === interruptedFence.playback_id));
const wrongBotSession = await call(`${turns}/${interruptedReady.turn_id}/speech/events`, second.access_token, 'POST', { ...interruptedFence, event: 'ended' });
assert.equal(wrongBotSession.status, 404);
const wrongBotGeneration = await call(`${turns}/${interruptedReady.turn_id}/speech/events`, token, 'POST', {
  ...interruptedFence, output_generation: interruptedFence.output_generation + 1, event: 'ended' });
assert.equal(wrongBotGeneration.status, 404);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, interruptedFence.playback_id);
const waitingBot = await submit(payload({ silent: false, text: 'Wait until the previous Bot audio stops.' }));
assert.equal(waitingBot.status, 202);
await until(async () => (await read(waitingBot.body.turn_id)).body.speech?.status === 'preparing', 'new Bot waits for cancelled playing Bot');
await pause(200);
assert.ok(!activity.events.some(item => item.event === 'speech:prepare' && item.data.playback_id === waitingBot.body.speech.playback_id));
const actualBotStop = await call(`${turns}/${interruptedReady.turn_id}/speech/events`, token, 'POST', { ...interruptedFence, event: 'ended' });
assert.equal(actualBotStop.status, 200, JSON.stringify(actualBotStop.body));
assert.equal(actualBotStop.body.snapshot.speech.status, 'cancelled', 'actual stop does not rewrite the cancellation outcome');
await activity.event('speech:ended', item => item.playback_id === interruptedFence.playback_id);
const waitingBotReady = await until(async () => { const value = (await read(waitingBot.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'new Bot after actual stop');
const waitingFence = { playback_id: waitingBotReady.speech.playback_id, output_generation: waitingBotReady.speech.output_generation };
assert.equal((await call(`${turns}/${waitingBotReady.turn_id}/speech/cancel`, token, 'POST', waitingFence)).body.accepted, true);
await activity.event('speech:ended', item => item.playback_id === waitingFence.playback_id);
assert.equal(await redis.get(`desktop:speech:slot:${owner}`), null, 'never-started audio releases immediately when cancelled');
interruptedObserver.ws.close(); groups++;

// A player reporting an actual failed stop also releases only its fenced
// cancelled playback, while retaining the cancelled result for the app.
const failedBot = await submit(payload({ silent: false, text: 'Speech that the player will stop with an error.' }));
assert.equal(failedBot.status, 202);
const failedReady = await until(async () => { const value = (await read(failedBot.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'Bot ready for failed stop proof');
const failedFence = { playback_id: failedReady.speech.playback_id, output_generation: failedReady.speech.output_generation };
const failedAudio = await fetch(base + failedReady.speech.audio_url, { headers: { Authorization: `Bearer ${token}`,
  'X-Dima-Audio-Ticket': failedReady.speech.ticket } });
assert.equal(failedAudio.status, 200); await failedAudio.arrayBuffer();
assert.equal((await call(`${turns}/${failedReady.turn_id}/speech/events`, token, 'POST', { ...failedFence, event: 'started' })).status, 200);
await db.collection('desktop_ai_turns').updateOne({ _id: failedReady.turn_id, 'speech.status': 'playing' },
  { $set: { 'speech.playbackDeadline': new Date(Date.now() + 12_000) } });
const failedCancel = await call(`${turns}/${failedReady.turn_id}/speech/cancel`, token, 'POST', failedFence);
assert.equal(failedCancel.status, 200); assert.equal(failedCancel.body.accepted, true);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, failedFence.playback_id);
const failedStop = await call(`${turns}/${failedReady.turn_id}/speech/events`, token, 'POST', { ...failedFence, event: 'failed' });
assert.equal(failedStop.status, 200, JSON.stringify(failedStop.body));
assert.equal(failedStop.body.snapshot.speech.status, 'cancelled');
await activity.event('speech:ended', item => item.playback_id === failedFence.playback_id); groups++;

// Speech-only mute during generation suppresses synthesis while retaining AI completion.
await redis.set('desktop:test:mode', 'hold');
const muted = await submit(payload({ silent: false })); assert.equal(muted.status, 202);
assert.equal(muted.body.speech.status, 'queued');
const muteFence = { playback_id: muted.body.speech.playback_id, output_generation: muted.body.speech.output_generation };
r = await call(`${turns}/${muted.body.turn_id}/speech/cancel`, token, 'POST', muteFence);
assert.equal(r.status, 200); assert.equal(r.body.accepted, true);
const muteDone = successful(await settled(muted.body.turn_id));
assert.equal(muteDone.speech.status, 'cancelled');
r = await call(`${turns}/${muted.body.turn_id}/speech/cancel`, token, 'POST', muteFence);
assert.equal(r.status, 200); assert.equal(r.body.accepted, true);
await redis.del('desktop:test:mode'); groups++;

await redis.set('desktop:test:mode', 'long');
const long = await submit(payload()); assert.equal(long.status, 202);
assert.ok(successful(await settled(long.body.turn_id)).reply_text.length <= 500);
await redis.set('desktop:test:mode', 'action');
const action = await submit(payload({ text: 'Hey Dima, change my title.' }));
assert.equal(action.status, 202); const actionDone = successful(await settled(action.body.turn_id));
assert.ok(actionDone.actions.some(item => item.tool === 'AST_PARSER' && item.status === 'completed'));
assert.ok(actionDone.actions.length <= 16 && !JSON.stringify(actionDone.actions).includes('Desktop fixture title'));
const writes = (await redis.lRange('desktop:test:twitch-writes', 0, -1)).map(JSON.parse);
assert.equal(writes.filter(item => item.method === 'PATCH' && item.path === '/helix/channels').length, 1,
  'normal permission-checked streamer tool executes once');
assert.ok(!writes.some(item => item.body.includes(original.text.trim())), 'raw desktop conversation is not posted as chat');
assert.equal((await submit({ ...original })).body.turn_id, first.turn_id);
for (const mode of ['self', 'protected']) {
  await redis.set('desktop:test:mode', mode);
  const denied = await submit(payload()); assert.equal(denied.status, 202); successful(await settled(denied.body.turn_id));
}
assert.ok(!(await redis.lRange('desktop:test:twitch-writes', 0, -1)).map(JSON.parse)
  .some(item => item.path.includes('/moderation/bans')), 'ban.self and broadcaster targets remain protected');
await redis.set('desktop:test:mode', 'memory');
const memoryTurn = await submit(payload({ text: 'Hey Dima, remember that I prefer tea.' }));
assert.equal(memoryTurn.status, 202);
const memoryResult = successful(await settled(memoryTurn.body.turn_id));
assert.ok(memoryResult.actions.some(item => item.tool === 'create_memory' && item.status === 'completed'));
const { ChannelAIMemorySchema } = await import('/app/dist/schemas/channel_ai_memory.schema.js');
const memory = await ChannelAIMemorySchema.findOne({ channelID: owner, content: 'Streamer prefers tea' }).lean();
assert.ok(memory, 'normal memory policy accepts the streamer memory');
assert.equal(memory.createdBy.source, 'oauth_desktop');
assert.equal(memory.sourceEvidence[0].source, 'oauth_desktop');
assert.equal(memory.subject.userID, owner);
await redis.del('desktop:test:mode'); groups++;

// An ambiguous provider result is retained and never automatically replayed.
await redis.set('desktop:test:mode', 'ambiguous');
const beforeUnknown = await redis.lLen('desktop:test:llm');
const ambiguousInput = payload(), ambiguous = await submit(ambiguousInput); assert.equal(ambiguous.status, 202);
const unknown = await settled(ambiguous.body.turn_id);
assert.equal(unknown.status, 'indeterminate', JSON.stringify(unknown));
assert.equal(unknown.error?.code, 'operation_outcome_unknown');
const receipt = await db.collection('desktop_ai_turns').findOne({ _id: ambiguous.body.turn_id });
assert.ok(receipt.operations.some(item => item.kind === 'provider' && item.status === 'pending'));
assert.equal(await redis.lLen('desktop:test:llm'), beforeUnknown + 1);
assert.equal((await submit(ambiguousInput)).body.turn_id, ambiguous.body.turn_id);
assert.equal((await submit({ ...ambiguousInput, text: 'A different request' })).status, 409);
await pause(350);
assert.equal(await redis.lLen('desktop:test:llm'), beforeUnknown + 1, 'lookup/conflict does not retry unknown provider outcome');
await currentHint(unknown);
await redis.del('desktop:test:mode'); groups++;

// Recreate a preexisting queued row and an interrupted running row in disposable
// storage. The API's ordinary recovery loop must claim only the queued work.
const recoveredInput = payload({ text: 'A queued request after API recovery.' });
const recoveredTurn = randomUUID(), recoveredConversation = randomUUID(), createdAt = new Date();
const baseRow = { ownerId, clientId: 'dima-desktop', channelId: owner, sessionId: full.session_id,
  origin: 'oauth_desktop', target: 'bot', source: 'asr', silent: true, revision: 1,
  createdAt, expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000) };
const fingerprint = input => createHash('sha256').update(JSON.stringify([
  input.target, input.text, input.source, input.silent, input.conversation_id ?? null
])).digest('hex');
await db.collection('desktop_ai_conversations').insertOne({ _id: recoveredConversation, ownerId, channelId: owner,
  target: 'bot', createdAt, expiresAt: new Date(createdAt.getTime() + 86_400_000) });
await db.collection('desktop_ai_turns').insertOne({ ...baseRow, _id: recoveredTurn, requestId: recoveredInput.request_id,
  conversationId: recoveredConversation, text: recoveredInput.text, fingerprint: fingerprint(recoveredInput), status: 'queued', operations: [] });
const beforeRecovery = await redis.lLen('desktop:test:llm');
successful(await settled(recoveredTurn));
assert.equal(await redis.lLen('desktop:test:llm'), beforeRecovery + 1);
assert.equal((await submit(recoveredInput)).body.turn_id, recoveredTurn, 'recovered work retains its durable identity');
const interruptedInput = payload({ text: 'An interrupted provider request.' });
const interruptedTurn = randomUUID();
await db.collection('desktop_ai_turns').insertOne({ ...baseRow, _id: interruptedTurn, requestId: interruptedInput.request_id,
  conversationId: randomUUID(), text: interruptedInput.text, fingerprint: fingerprint(interruptedInput), status: 'running',
  runDeadline: new Date(Date.now() - 1000), operations: [{ id: 'provider:interrupted', kind: 'provider', status: 'pending' }] });
const beforeInterrupted = await redis.lLen('desktop:test:llm');
const interrupted = await settled(interruptedTurn);
assert.equal(interrupted.status, 'indeterminate');
assert.equal(interrupted.error.code, 'operation_outcome_unknown');
assert.equal(await redis.lLen('desktop:test:llm'), beforeInterrupted, 'interrupted pending work is not retried');
groups++;

// Hold only this disposable owner's execution lease to prove bounded admission
// and cancellation independently of provider speed. Duplicates still reconcile.
const ownerLease = `desktop-ai:owner:${ownerId}`;
await until(async () => await redis.set(ownerLease, 'fixture-held-lease', { NX: true, PX: 60_000 }), 'fixture owner lease');
const admittedWhileHeld = [];
for (let i = 0; i < 20; i++) {
  const input = payload({ text: `Bounded queue fixture ${i}` }), result = await submit(input);
  assert.equal(result.status, 202, JSON.stringify(result)); admittedWhileHeld.push({ input, turn: result.body });
}
const saturated = await submit(payload({ text: 'One beyond the bounded queue.' }));
assert.equal(saturated.status, 429); assert.equal(saturated.body.error, 'queue_full');
assert.ok(saturated.headers.get('retry-after'));
assert.equal((await submit(admittedWhileHeld[0].input)).body.turn_id, admittedWhileHeld[0].turn.turn_id);
for (const { turn } of admittedWhileHeld) {
  const cancelled = await call(`${turns}/${turn.turn_id}/cancel`, token, 'POST', {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.accepted, true);
}
assert.equal(await redis.zCard(`desktop-ai:queue:${ownerId}`), 0);
assert.equal(await redis.get(ownerLease), 'fixture-held-lease');
await redis.del(ownerLease); groups++;

// A live subscriber that fails to pause cannot let the first audible sample through.
const unresponsive = await connect('/desktop-ai', second.access_token, false);
await unresponsive.event('speech:snapshot');
const blockedAt = Date.now();
const blocked = await submit(payload({ silent: false })); assert.equal(blocked.status, 202);
const blockedFinal = await until(async () => {
  const value = (await read(blocked.body.turn_id)).body;
  return ['failed', 'indeterminate'].includes(value.speech?.status) ? value : null;
}, 'unacknowledged speech barrier', 12_000);
assert.equal(blockedFinal.speech.status, 'failed');
assert.equal(blockedFinal.speech.error.code, 'output_unavailable');
await until(() => unresponsive.ws.readyState === WebSocket.CLOSED, 'unresponsive subscriber disconnected');
assert.ok(unresponsive.events.some(item => item.event === 'speech:prepare'));
assert.ok(!unresponsive.events.some(item => item.event === 'speech:started' && item.data.playback_id === blocked.body.speech.playback_id));
assert.equal(blockedFinal.speech.audio_url, undefined);
await currentHint(blockedFinal);
assert.ok(Date.now() - blockedAt < 8_000, 'known failure is pushed without waiting for the delivery deadline'); groups++;

// A ready turn remains collectable after the former15s cutoff; readiness starts
// the20s clock, independently from the LLM execution timeout.
const late = await submit(payload({ silent: false })); assert.equal(late.status, 202);
const lateReady = await until(async () => { const value = (await read(late.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'late collection ready');
await currentHint(lateReady);
await pause(16_000);
assert.ok(lateReady.speech.start_before > Date.now(), '20s delivery window still open after16s');
const lateAudio = await fetch(base + lateReady.speech.audio_url, { headers: { Authorization: `Bearer ${token}`,
  'X-Dima-Audio-Ticket': lateReady.speech.ticket } });
assert.equal(lateAudio.status, 200); await lateAudio.arrayBuffer();
const lateFence = { playback_id: lateReady.speech.playback_id, output_generation: lateReady.speech.output_generation };
assert.equal((await call(`${turns}/${lateReady.turn_id}/speech/events`, token, 'POST', { ...lateFence, event: 'started' })).body.snapshot.speech.status, 'playing');
assert.equal((await call(`${turns}/${lateReady.turn_id}/speech/events`, token, 'POST', { ...lateFence, event: 'ended' })).body.snapshot.speech.status, 'completed');
groups++;

// Lost start acknowledgement eventually ends the reservation authoritatively.
const expiring = await submit(payload({ silent: false })); assert.equal(expiring.status, 202);
const expiryReady = await until(async () => {
  const value = (await read(expiring.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null;
}, 'expiry case ready');
const expiryTicketTTL = await redis.pTTL(`desktop-ai:ticket:${expiryReady.turn_id}`);
assert.ok(expiryTicketTTL > 18_000 && expiryTicketTTL <= 20_000);
const expiryEnded = await activity.event('speech:ended', item => item.playback_id === expiryReady.speech.playback_id && item.reason === 'expired', 26_000);
assert.ok(Number.isSafeInteger(expiryEnded.server_time));
const expiredSnapshot = (await read(expiring.body.turn_id)).body;
assert.equal(expiredSnapshot.speech.status, 'expired');
assert.ok(Date.now() >= expiryReady.speech.start_before);
assert.ok(Date.now() - expiryReady.speech.start_before < 6_500, 'expiry is reconciled promptly after20s');
assert.equal(await redis.get(`desktop-ai:ticket:${expiryReady.turn_id}`), null);
await currentHint(expiredSnapshot);
assert.ok([403,409].includes((await fetch(base + expiryReady.speech.audio_url, { headers: { Authorization: `Bearer ${token}`,
  'X-Dima-Audio-Ticket': expiryReady.speech.ticket } })).status));
// Reconnect recovers by GET of tracked IDs; it does not replay old paid work.
plainActivity.ws.close(); activity.ws.close();
await until(() => activity.ws.readyState === WebSocket.CLOSED && plainActivity.ws.readyState === WebSocket.CLOSED, 'initiating fixtures close');
const reconnectActivity = await connect('/desktop-ai', token, true, ['turn-status-v1']);
await reconnectActivity.event('speech:snapshot');
const beforeReconnect = await redis.lLen('desktop:test:llm');
assert.equal((await read(expiryReady.turn_id)).body.speech.status, 'expired');
assert.equal(await redis.lLen('desktop:test:llm'), beforeReconnect);
// Keep the existing activity recorder for later historical assertions; the new
// connection continues to ACK barriers for the remaining Pet/TTS regressions.
reconnectActivity.ws.close();
await until(() => reconnectActivity.ws.readyState === WebSocket.CLOSED, 'reconnect fixture closes');
// Subsequent checks expect activity.event to follow new output.
const resumedActivity = await connect('/desktop-ai', token, true, ['turn-status-v1']);
activity.ws = resumedActivity.ws;
const historicalEvents = activity.events;
activity.events = resumedActivity.events;
activity.events.unshift(...historicalEvents);
activity.event = resumedActivity.event;
groups++;

// A browser/legacy normal-TTS overlay cannot receive audio until a slow desktop
// subscriber has acknowledged microphone suppression, and its terminal clears it.
const legacySpeech = await connect(`/speech/${owner}`);
await until(() => legacySpeech.events.some(item => item.event === 'speech-reset'), 'legacy browser TTS ready');
const gated = await connect('/desktop-ai', second.access_token, false);
await gated.event('speech:snapshot');
const normalTts = await call(`/speech/${owner}`, undefined, 'POST', { text: 'A browser TTS fixture.' });
assert.equal(normalTts.status, 200, JSON.stringify(normalTts.body));
const normalId = normalTts.body.data.speechID;
const normalPrepare = await gated.event('speech:prepare', item => item.source === 'tts' && item.playback_id === normalId);
assert.ok(Number.isSafeInteger(normalPrepare.server_time));
assert.ok(!legacySpeech.events.some(item => item.event === 'speech' && item.data.speechID === normalId), 'no audio before pause ACK');
gated.acknowledge('speech:prepare', normalId);
await legacySpeech.event('speech', item => item.speechID === normalId);
await activity.event('speech:started', item => item.source === 'tts' && item.playback_id === normalId);
legacySpeech.emit('speech-ended', { speechID: normalId, reason: 'ended' });
await activity.event('speech:ended', item => item.source === 'tts' && item.playback_id === normalId);
gated.ws.close(); groups++;

// Skip requests a stop, but cannot release the microphone while the selected
// browser could still be audible. A late report from another browser is stale.
const legacyOther = await connect(`/speech/${owner}`);
await until(() => legacyOther.events.some(item => item.event === 'speech-reset'), 'second legacy browser ready');
const skipping = await call(`/speech/${owner}`, undefined, 'POST', { text: 'Wait for the selected browser to stop.' });
assert.equal(skipping.status, 200); const skippedId = skipping.body.data.speechID;
const selectedLegacy = await until(() => [legacySpeech, legacyOther].find(peer => peer.events.some(item =>
  item.event === 'speech' && item.data.speechID === skippedId)), 'one selected legacy player');
const wrongLegacy = selectedLegacy === legacySpeech ? legacyOther : legacySpeech;
await activity.event('speech:started', item => item.playback_id === skippedId);
r = await call(`/speech/${owner}/control`, 'pet-owner-token', 'POST', { action: 'skip' });
assert.equal(r.status, 200, JSON.stringify(r.body));
const retiredTts = await until(async () => {
  const raw = await redis.get(`desktop:speech:slot:${owner}`); if (!raw) return null;
  const slot = JSON.parse(raw); return slot.playbackId === skippedId && slot.retiredProof ? slot : null;
}, 'retired browser output');
assert.equal(retiredTts.retiredProof.kind, 'tts');
const ttsObserver = await connect('/desktop-ai', second.access_token);
assert.equal((await ttsObserver.event('speech:snapshot')).active[0].playback_id, skippedId);
wrongLegacy.emit('speech-ended', { speechID: skippedId, reason: 'ended' });
await pause(200);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, skippedId);
assert.ok(!activity.events.some(item => item.event === 'speech:ended' && item.data.playback_id === skippedId));
const botWhileRetired = await submit(payload({ silent: false, text: 'Answer after the browser stops.' }));
assert.equal(botWhileRetired.status, 202);
await until(async () => (await read(botWhileRetired.body.turn_id)).body.speech?.status === 'preparing', 'Bot waits for retired browser');
await pause(200);
assert.ok(!activity.events.some(item => item.event === 'speech:prepare' && item.data.playback_id === botWhileRetired.body.speech.playback_id));
selectedLegacy.emit('speech-ended', { speechID: skippedId, reason: 'ended' });
const retiredTtsEnd = await activity.event('speech:ended', item => item.playback_id === skippedId);
assert.equal(retiredTtsEnd.reason, 'stopped');
const afterTtsStop = await until(async () => { const value = (await read(botWhileRetired.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'Bot ready after actual browser stop');
selectedLegacy.emit('speech-ended', { speechID: skippedId, reason: 'ended' });
await pause(100);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, afterTtsStop.speech.playback_id,
  'late duplicate browser terminal cannot release the new Bot output');
assert.equal((await call(`${turns}/${afterTtsStop.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: afterTtsStop.speech.playback_id, output_generation: afterTtsStop.speech.output_generation })).body.accepted, true);
ttsObserver.ws.close(); legacySpeech.ws.close(); legacyOther.ws.close(); groups++;

// Configure a real private Pet asset and select the initiating desktop as audio owner.
const { PetRuntime, PetRequest } = await import('/app/dist/schemas/pet_runtime.schema.js');
const assetId = new ObjectId();
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const upload = new GridFSBucket(db, { bucketName: 'private_assets' }).openUploadStreamWithId(assetId, 'pet.gif', { metadata: { owner, mime: 'image/gif' } });
const stored = once(upload, 'finish'); upload.end(gif); await stored;
await db.collection('asset_libraries').insertOne({ _id: owner, usedBytes: gif.length, assets: [{
  id: String(assetId), name: 'pet.gif', kind: 'image', mime: 'image/gif', bytes: gif.length,
  width: 1, height: 1, state: 'ready', createdAt: new Date().toISOString() }] });
const settingsPath = `/pets/${owner}/settings`;
let petConfig = await call(settingsPath, 'pet-owner-token');
assert.equal(petConfig.status, 200); petConfig = petConfig.body.data;
const settings = { ...petConfig.settings, enabled: true, moods: { ...petConfig.settings.moods, enabled: true },
  appearance: { kind: 'png', idleAssetId: String(assetId), talkingAssetId: String(assetId) },
  behavior: { ...petConfig.settings.behavior, cooldownSeconds: 3600, respondToChat: false, respondToEvents: false } };
r = await call(settingsPath, 'pet-owner-token', 'PUT', { revision: petConfig.revision, settings });
assert.equal(r.status, 200, JSON.stringify(r.body)); petConfig = r.body.data;
const ready = { v: 1, audioReady: true, renderReady: true, vtsReady: false };
assert.equal((await desktop.send('pet:ready', ready)).ok, true);
r = await call('/v1/me/pet/playback', token, 'PUT', { commandId: randomUUID(), revision: petConfig.revision, roles: ['audio'] });
assert.equal(r.status, 200, JSON.stringify(r.body)); petConfig = r.body;
let leaseAck = await desktop.send('pet:lease', { v: 1, action: 'acquire' });
assert.equal(leaseAck.ok, true, JSON.stringify(leaseAck));
let lease = leaseAck.data, renewing = false;
const renewal = setInterval(() => {
  if (renewing || desktop.ws.readyState !== WebSocket.OPEN) return;
  renewing = true;
  void desktop.send('pet:lease', { v: 1, action: 'renew', leaseId: lease.leaseId, generation: lease.generation })
    .then(ack => { if (ack.ok) lease = ack.data; }).finally(() => { renewing = false; });
}, 5000); renewal.unref();
await PetRuntime.updateOne({ _id: ownerId }, { $set: { lastAcceptedAt: new Date() } });
const petCallsBefore = await redis.lLen('desktop:test:llm');
const petAudioBefore = (await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts').length;
await redis.set('desktop:test:mode', 'moods');
const pet = await submit(payload({ target: 'pet', silent: false, text: 'Hey Dima, how are you?' }));
assert.equal(pet.status, 202);
const petReady = await until(async () => {
  const value = (await read(pet.body.turn_id)).body;
  if (value.speech?.status === 'failed' || value.status === 'failed') throw new Error(JSON.stringify(value));
  return value.pet_request_id && value.reply_text ? value : null;
}, 'pet request linked');
assert.equal(petReady.speech.transport, 'pet_socket'); assert.equal(petReady.speech.animate_pet, true);
assert.equal(petReady.speech.audio_url, undefined);
const petPlay = await desktop.event('pet:play', item => item.requestId === petReady.pet_request_id, 25_000);
await currentHint((await read(pet.body.turn_id)).body);
await redis.del('desktop:test:mode');
const firstMood = process.env.DIMA046_MOOD_FAILURES === 'first' ? 'neutral' : 'angry';
assert.equal((await PetRequest.findById(petReady.pet_request_id).lean()).mood, firstMood, 'desktop mood extraction failure cannot prevent actual Pet playback');
assert.equal(petReady.reply_text.includes('[anger]'), false, 'existing provider filtering still strips raw cues');
assert.equal(desktop.events.find(item => item.event === 'pet:request' && item.data.request.requestId === petReady.pet_request_id && item.data.request.status === 'ready').data.request.mood, firstMood);
assert.equal(JSON.stringify(JSON.parse((await redis.lRange('desktop:test:llm', -1, -1))[0]).messages).includes('Begin your reply with exactly one emotion tag'), process.env.DIMA046_MOOD_FAILURES !== 'first', 'desktop instruction failure omits only decoration');
assert.equal(await redis.lLen('desktop:test:llm'), petCallsBefore + 1, 'Pet uses one shared AI answer');
const petCalls = (await redis.lRange('pet:test:provider-calls', 0, -1)).map(JSON.parse).filter(item => item.kind === 'tts');
assert.equal(petCalls.length, petAudioBefore + 1); assert.equal(petCalls.at(-1).body.text, petReady.reply_text);
assert.equal(desktop.events.filter(item => item.event === 'pet:play' && item.data.requestId === petReady.pet_request_id).length, 1);
assert.ok(!old.events.some(item => item.event === 'pet:play' && item.data.requestId === petReady.pet_request_id));
const petPrepare = await activity.event('speech:prepare', item => item.playback_id === petReady.pet_request_id);
assert.ok(petPrepare.server_time <= petPrepare.expires_at);
assert.equal(petPrepare.source, 'pet');
const petReport = (play, seq, phase) => ({ v: 1, requestId: play.requestId, leaseId: play.leaseId,
  generation: play.generation, seq, phase, positionMs: phase === 'ended' ? 500 : 0 });
assert.equal((await desktop.send('pet:playback', petReport(petPlay, 0, 'started'))).ok, true);

// A different authorized session cannot take over the selected player's output.
const wrongOwner = await call(turns, second.access_token, 'POST', payload({ target: 'pet', silent: false }));
assert.equal(wrongOwner.status, 202);
const deniedOwner = await until(async () => {
  const value = (await call(`${turns}/${wrongOwner.body.turn_id}`, second.access_token)).body;
  return value.speech?.status === 'failed' ? value : null;
}, 'wrong-session output rejected');
assert.equal(deniedOwner.speech.error.code, 'output_unavailable');
assert.equal(deniedOwner.pet_request_id, undefined);
assert.equal((await call('/v1/me/pet', token)).body.settings.playback.desktopSessionId, full.session_id);

// Cancel a separate queued Pet turn twice without clearing the first playing Pet.
const queued = await submit(payload({ target: 'pet', silent: false, text: 'Tell me another short thing.' }));
assert.equal(queued.status, 202);
const waiting = await until(async () => { const value = (await read(queued.body.turn_id)).body;
  return value.pet_request_id ? value : null; }, 'second Pet queued');
r = await call(`${turns}/${waiting.turn_id}/cancel`, token, 'POST', {}); assert.equal(r.status, 200);
assert.equal(r.body.snapshot.speech.status, 'cancelled');
r = await call(`${turns}/${waiting.turn_id}/cancel`, token, 'POST', {}); assert.equal(r.status, 200);
assert.equal((await db.collection('pet_requests').findOne({ _id: waiting.pet_request_id })).status, 'cancelled');
assert.equal((await db.collection('pet_requests').findOne({ _id: petReady.pet_request_id })).status, 'playing');
assert.equal((await desktop.send('pet:playback', petReport(petPlay, 1, 'ended'))).ok, true);
await activity.event('speech:ended', item => item.playback_id === petReady.pet_request_id);
assert.equal((await read(petReady.turn_id)).body.speech.status, 'completed');
groups++;

async function playAnotherPet(text) {
  const submitted = await submit(payload({ target: 'pet', silent: false, text }));
  assert.equal(submitted.status, 202);
  const turn = await until(async () => { const value = (await read(submitted.body.turn_id)).body;
    if (value.speech?.status === 'failed' || value.status === 'failed') throw new Error(JSON.stringify(value));
    return value.pet_request_id ? value : null; }, 'next Pet request linked');
  const play = await desktop.event('pet:play', item => item.requestId === turn.pet_request_id, 25_000);
  assert.equal((await desktop.send('pet:playback', petReport(play, 0, 'started'))).ok, true);
  return { turn, play };
}
const activePet = await playAnotherPet('Tell me something brief before I mute you.');
r = await call(`${turns}/${activePet.turn.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: activePet.turn.speech.playback_id, output_generation: activePet.turn.speech.output_generation });
assert.equal(r.status, 200); assert.equal(r.body.accepted, true);
await desktop.event('pet:stop', item => item.requestId === activePet.turn.pet_request_id);
const retiredPet = await until(async () => {
  const raw = await redis.get(`desktop:speech:slot:${owner}`); if (!raw) return null;
  const slot = JSON.parse(raw); return slot.playbackId === activePet.turn.pet_request_id && slot.retiredProof ? slot : null;
}, 'retired Pet output');
assert.equal(retiredPet.retiredProof.kind, 'pet');
const petObserver = await connect('/desktop-ai', token);
assert.equal((await petObserver.event('speech:snapshot')).active[0].playback_id, activePet.turn.pet_request_id);
const wrongPeer = await old.send('pet:playback', petReport(activePet.play, 1, 'ended'));
assert.equal(wrongPeer.ok, false, 'different desktop peer cannot prove the selected player stopped');
const staleProof = await desktop.send('pet:playback', { ...petReport(activePet.play, 1, 'stopped'), generation: activePet.play.generation + 1 });
assert.equal(staleProof.ok, false, 'wrong generation cannot clear a retired activity');
await pause(200);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, activePet.turn.pet_request_id);
assert.ok(!activity.events.some(item => item.event === 'speech:ended' && item.data.playback_id === activePet.turn.pet_request_id));
const botWhilePetStops = await submit(payload({ silent: false, text: 'Answer only after Pet stops.' }));
assert.equal(botWhilePetStops.status, 202);
await until(async () => (await read(botWhilePetStops.body.turn_id)).body.speech?.status === 'preparing', 'Bot waits for retired Pet');
await pause(200);
assert.ok(!activity.events.some(item => item.event === 'speech:prepare' && item.data.playback_id === botWhilePetStops.body.speech.playback_id));
const stopped = await desktop.send('pet:playback', petReport(activePet.play, 1, 'stopped'));
assert.equal(stopped.ok, true, JSON.stringify(stopped));
const petStopped = await activity.event('speech:ended', item => item.playback_id === activePet.turn.pet_request_id);
assert.equal(petStopped.reason, 'stopped');
const afterPetStop = await until(async () => { const value = (await read(botWhilePetStops.body.turn_id)).body;
  return value.speech?.status === 'ready' ? value : null; }, 'Bot ready after actual Pet stop');
assert.equal((await desktop.send('pet:playback', petReport(activePet.play, 2, 'stopped'))).ok, false);
assert.equal(JSON.parse(await redis.get(`desktop:speech:slot:${owner}`)).playbackId, afterPetStop.speech.playback_id,
  'late duplicate Pet stop cannot release the new Bot output');
assert.equal((await call(`${turns}/${afterPetStop.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: afterPetStop.speech.playback_id, output_generation: afterPetStop.speech.output_generation })).body.accepted, true);
petObserver.ws.close(); groups++;

// Set up a fresh lease in disposable Mongo after confirmed stop, then shorten
// only that lease to exercise the real expiry path without a 15-second wait.
await PetRuntime.updateOne({ _id: ownerId }, { $set: { notBefore: new Date(0) } });
leaseAck = await desktop.send('pet:lease', { v: 1, action: 'acquire' });
assert.equal(leaseAck.ok, true, JSON.stringify(leaseAck)); lease = leaseAck.data;
const expiresPet = await playAnotherPet('This Pet stop will expire.');
clearInterval(renewal);
await until(() => !renewing, 'lease renewal has settled');
const shortLease = new Date(Date.now() + 3000);
const shortLeaseUpdate = await PetRuntime.updateOne({ _id: ownerId, 'lease.leaseId': expiresPet.play.leaseId },
  { $set: { 'lease.expiresAt': shortLease } });
assert.equal(shortLeaseUpdate.modifiedCount, 1);
r = await call(`${turns}/${expiresPet.turn.turn_id}/speech/cancel`, token, 'POST', {
  playback_id: expiresPet.turn.speech.playback_id, output_generation: expiresPet.turn.speech.output_generation });
assert.equal(r.status, 200); assert.equal(r.body.accepted, true);
const expiringSlot = await until(async () => {
  const raw = await redis.get(`desktop:speech:slot:${owner}`); if (!raw) return null;
  const slot = JSON.parse(raw); return slot.playbackId === expiresPet.turn.pet_request_id && slot.retiredProof ? slot : null;
}, 'expiring Pet output');
assert.ok(expiringSlot.expiresAt <= shortLease.getTime());
await pause(200);
assert.ok(!activity.events.some(item => item.event === 'speech:ended' && item.data.playback_id === expiresPet.turn.pet_request_id));
const petExpired = await activity.event('speech:ended', item => item.playback_id === expiresPet.turn.pet_request_id, 7000);
assert.equal(petExpired.reason, 'expired'); assert.ok(Number.isSafeInteger(petExpired.server_time));
assert.equal(await redis.get(`desktop:speech:slot:${owner}`), null);
groups++;

for (const ws of sockets) ws.close();
console.log(`PASS desktop AI: ${groups} groups; advertised/negotiated committed hints, legacy/session/scope isolation, in-flight stale GET and polling fallback, exact Bot/Pet wire revisions,20s delivery and16s fetch, one-fetch started proof, no paid replay, consent/idempotency, private Bot TTS, output barrier/expiry, uncertainty and fenced cancellation`);
process.exit(0);
