// DimaFX playback queue check; use dimafx-fixtures with disposable Redis/Mongo.
// Covers: sequential queueing with overlay acks, duration-timeout fallback,
// Twitch transaction idempotency (duplicate/resume/refunded states), custom
// TTS synthesis at dispatch time, the broadcaster test trigger, overlay
// status, and viewer refunds when no overlay is connected.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';

const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const mongoose = require('mongoose');

const root = 'http://127.0.0.1:3000';
const channel = '999983';
const serviceHeaders = { 'Content-Type': 'application/json', 'x-dimafx-service-token': 'fixture-service-token' };
const authHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-dimafx-token' };

const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
await mongoose.connect('mongodb://mongo:27017/saas_ops_dimafx_test');
const db = mongoose.connection.db;

const sockets = [];
const children = [];
const wait = async (condition, description) => {
  const deadline = Date.now() + 40000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const overlayStatus = () => fetch(`${root}/extensions/dimafx/internal/channels/${channel}/overlay-status`, { headers: serviceHeaders }).then(r => r.json());
const connectOverlay = async ({ port = 3000, id = channel, legacy = false, ready = true, token } = {}) => {
  const namespace = `/overlays/${legacy ? 'triggers' : 'dimafx'}/${id}`;
  const triggers = [];
  const deliveries = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const authToken = token ?? createHmac('sha256', process.env.SECRET_KEY).update(`dimafx-overlay:${id}`).digest('hex');
  let connected = false, rejected = false;
  sockets.push(ws);
  ws.addEventListener('message', (event) => {
    const data = String(event.data);
    if (data === '2') ws.send('3');
    else if (data.startsWith('0')) ws.send(`40${namespace},${JSON.stringify({ token: authToken })}`);
    else if (data.startsWith(`40${namespace},`)) {
      connected = true;
      if (ready && !legacy) ws.send(`42${namespace},["dimafx-ready"]`);
    } else if (data.startsWith(`44${namespace},`)) rejected = true;
    else if (data.startsWith(`42${namespace},`)) {
      const [name, payload] = JSON.parse(data.slice(`42${namespace},`.length));
      if (name === 'dimafx-play' || name === 'trigger') {
        deliveries.push(payload);
        if (!triggers.some(t => t.triggerID === payload.triggerID)) triggers.push(payload);
      }
    }
  });
  await wait(() => connected || rejected, 'overlay handshake');
  return {
    ws, triggers, deliveries, rejected,
    ready() { ws.send(`42${namespace},["dimafx-ready"]`); },
    ack(id) { ws.send(`42${namespace},${JSON.stringify(['dimafx-ended', { triggerID: id }])}`); },
  };
};

const purchase = (itemID, body) =>
  fetch(`${root}/extensions/dimafx/internal/channels/${channel}/items/${itemID}/purchase`, {
    method: 'POST', headers: serviceHeaders, body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, ...(await response.json()) }));

try {
  // Seed: channel account (websocket namespace auth) + dashboard token cache.
  await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'dimafx-fixture', plan_tier: 'premium' });
  await redis.hSet(`token:fixture-dimafx-token`, { id: channel, login: 'dimafx-fixture', display_name: 'Fixture' });

  const assetID = new mongoose.Types.ObjectId();
  await db.collection('mediaassets').insertOne({
    _id: assetID, ownerUserID: channel, ownerChannelID: channel, ownerChannelName: 'dimafx-fixture',
    uploadedByUserID: channel, originalName: 'clip.mp4', displayName: 'Fixture Clip', fileName: 'clip.mp4',
    extension: 'mp4', mimeType: 'video/mp4', mediaType: 'video', bytes: 1000, bucket: 'fixture',
    s3Key: 'fixture/clip.mp4', storageUrl: 'https://api.domdimabot.com/media/fixture', scope: 'private',
    marketplaceStatus: 'not_listed', thumbnailStatus: 'skipped', deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });

  const videoItem = new mongoose.Types.ObjectId();
  const imageItem = new mongoose.Types.ObjectId();
  const ttsItem = new mongoose.Types.ObjectId();
  const baseItem = {
    channelID: channel, channelName: 'dimafx-fixture', createdByUserID: channel,
    description: '', thumbnailUrl: '', volume: 80, isEnabled: true, sortOrder: 0,
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  await db.collection('channelextensionitems').insertMany([
    { ...baseItem, _id: videoItem, assetID, name: 'Fixture Clip', category: 'video', mediaType: 'video', durationMs: 2000, bitsPrice: 5, sku: 'dimafx_bits_5' },
    { ...baseItem, _id: imageItem, assetID, name: 'Fixture GIF', category: 'gif', mediaType: 'gif', durationMs: 1200, bitsPrice: 5, sku: 'dimafx_bits_5' },
    { ...baseItem, _id: ttsItem, assetID: null, name: 'Fixture TTS', category: 'tts', mediaType: 'audio', durationMs: 0, bitsPrice: 0, sku: 'free', tts: { mode: 'custom', text: '', voice: '', language: 'en' } },
  ]);

  // Overlay status before any overlay connects.
  const statusBefore = await fetch(`${root}/extensions/dimafx/${channel}/overlay-status`, { headers: authHeaders }).then((r) => r.json());
  assert.equal(statusBefore.data.connected, false, 'overlay reported disconnected before connect');

  assert.equal((await fetch(`${root}/overlays/dimafx/${channel}`)).status, 403, 'OBS page requires its token');
  assert.equal((await fetch(statusBefore.data.overlayUrl)).status, 200, 'dashboard supplies the working OBS link');
  const legacy = await connectOverlay({ legacy: true });
  assert.equal((await overlayStatus()).data.connected, false, 'legacy trigger socket cannot enable purchases');
  const invalid = await connectOverlay({ token: '0'.repeat(64) });
  assert.equal(invalid.rejected, true, 'unsigned viewer cannot register as an OBS player');
  let overlay = await connectOverlay({ ready: false });
  assert.equal((await overlayStatus()).data.connected, false, 'socket without player ready cannot enable purchases');
  overlay.ready();
  await wait(async () => (await overlayStatus()).data.connected, 'DimaFX player ready');
  const statusAfter = await fetch(`${root}/extensions/dimafx/${channel}/overlay-status`, { headers: authHeaders }).then((r) => r.json());
  assert.equal(statusAfter.data.connected, true, 'overlay reported connected after connect');

  // 1) First purchase dispatches immediately.
  const first = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-1', action: 'use_now' });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.queued, true);
  await wait(() => overlay.triggers.length === 1, 'first trigger dispatched');
  assert.equal(overlay.triggers[0].mediaType, 'video/mp4');
  assert.equal(overlay.triggers[0].volume, 80);
  assert.ok(overlay.triggers[0].triggerID, 'trigger carries an ID');

  // 2) Second purchase is held by the queue while the first plays.
  const second = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-2', action: 'use_now' });
  assert.equal(second.status, 200, JSON.stringify(second));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(overlay.triggers.length, 1, 'queue holds the second purchase during playback');

  // 3) Twitch retry of the first transaction resolves idempotently.
  const duplicate = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-1', action: 'use_now' });
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate));
  assert.equal(duplicate.data.duplicate, true, 'duplicate transaction reported without re-fulfillment');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(overlay.triggers.length, 1, 'duplicate transaction does not replay the trigger');
  assert.equal(await db.collection('extensionwallettransactions').countDocuments({ twitchTransactionID: 'tx-1' }), 1, 'single ledger row per Twitch transaction');
  const txOne = await db.collection('extensionwallettransactions').findOne({ twitchTransactionID: 'tx-1' });
  assert.equal(txOne.metadata.fulfillment, 'fulfilled');

  // 4) Ack advances the queue in order.
  overlay.ack(overlay.triggers[0].triggerID);
  await wait(() => overlay.triggers.length === 2, 'second trigger dispatched after ack');

  // 5) Without an ack the duration timeout still advances the queue.
  const third = await purchase(String(imageItem), { sku: 'dimafx_bits_5', transactionID: 'tx-3', action: 'use_now' });
  assert.equal(third.status, 200, JSON.stringify(third));
  overlay.ack(overlay.triggers[1].triggerID);
  await wait(() => overlay.triggers.length === 3, 'third trigger dispatched after ack');

  // 6) Custom TTS item: viewer text is synthesized at dispatch time, after the
  //    unacknowledged image item times out (~2s).
  const ttsPurchase = await purchase(String(ttsItem), { sku: 'free', transactionID: 'tx-4', action: 'use_now', ttsText: '  Hello   from the fixture https://spam.example ' });
  assert.equal(ttsPurchase.status, 200, JSON.stringify(ttsPurchase));
  await wait(() => overlay.triggers.length === 4, 'tts trigger dispatched after timeout');
  const ttsTrigger = overlay.triggers[3];
  assert.equal(ttsTrigger.mediaType, 'audio/wav');
  assert.ok(ttsTrigger.url.includes(`/speech/audio/${channel}/`), 'tts plays the synthesized speech URL');

  const synthCalls = fs.readFileSync('/tmp/saas-fixtures/provider-calls.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.synthesis);
  assert.equal(synthCalls.length, 1, 'exactly one synthesis for the queued tts item');
  assert.equal(synthCalls[0].synthesis.text, 'Hello from the fixture', 'viewer text trimmed and link-stripped');
  assert.equal(synthCalls[0].synthesis.voice, 'en_US-ryan-medium', 'falls back to the channel default voice');

  const audio = await fetch(ttsTrigger.url.replace('https://api.domdimabot.com', root));
  assert.equal(audio.status, 200, 'synthesized speech is served');
  assert.ok((await audio.arrayBuffer()).byteLength > 100, 'wav payload present');

  // 7) Custom TTS cannot be saved for later.
  const saveAttempt = await purchase(String(ttsItem), { sku: 'free', transactionID: 'tx-5', action: 'save', userID: 'viewer-2', ttsText: 'save me' });
  assert.equal(saveAttempt.status, 400, 'custom tts rejects save');

  // 8) Broadcaster test trigger (dashboard auth via seeded token cache).
  const test = await fetch(`${root}/extensions/dimafx/${channel}/items/${ttsItem}/test`, { method: 'POST', headers: authHeaders, body: '{}' })
    .then(async (response) => ({ status: response.status, ...(await response.json()) }));
  assert.equal(test.status, 200, JSON.stringify(test));
  overlay.ack(ttsTrigger.triggerID);
  await wait(() => overlay.triggers.length === 5, 'test trigger dispatched');
  assert.equal(overlay.triggers[4].name, 'Fixture TTS');
  const synthCalls2 = fs.readFileSync('/tmp/saas-fixtures/provider-calls.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.synthesis);
  assert.equal(synthCalls2.length, 2, 'test trigger synthesized the sample text');

  // 9) Disconnect: purchases fail fast and identified viewers are refunded.
  overlay.ack(overlay.triggers[4].triggerID);
  overlay.ws.close();
  await new Promise((resolve) => overlay.ws.addEventListener('close', resolve, { once: true }));
  await wait(async () => !(await overlayStatus()).data.connected, 'overlay disconnected');
  const offline = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-6', action: 'use_now', userID: 'viewer-1', displayName: 'Viewer One' });
  assert.equal(offline.status, 409, JSON.stringify(offline));
  const refundedInventory = await db.collection('userextensioninventories').findOne({ platform: 'twitch', userID: 'viewer-1', channelID: channel });
  assert.equal(refundedInventory.balance, 5, 'failed purchase converted to credits');
  const txSix = await db.collection('extensionwallettransactions').findOne({ twitchTransactionID: 'tx-6' });
  assert.equal(txSix.metadata.fulfillment, 'refunded');

  // 10) A retry of the refunded transaction reports the refunded state.
  const refundedRetry = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-6', action: 'use_now', userID: 'viewer-1' });
  assert.equal(refundedRetry.status, 409, JSON.stringify(refundedRetry));
  assert.equal(await db.collection('userextensioninventories').findOne({ platform: 'twitch', userID: 'viewer-1', channelID: channel }).then((doc) => doc.balance), 5, 'refund is not applied twice');

  // 11) Reconnect resumes playback for new purchases.
  overlay = await connectOverlay();
  await wait(async () => (await overlayStatus()).data.connected, 'reconnected ready player');
  const resumed = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-7', action: 'use_now' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed));
  await wait(() => overlay.triggers.length === 1, 'trigger dispatched after reconnect');
  overlay.ack(overlay.triggers[0].triggerID);
  await wait(async () => (await db.collection('dimafxplaybacks').countDocuments({ channelID: channel, state: { $nin: ['completed', 'refunded'] } })) === 0, 'queue drains');
  assert.equal(legacy.triggers.length, 0, 'DimaFX purchases never reach legacy trigger sockets');

  // Failure after durable enqueue, before purchase-ledger finalization.
  fs.writeFileSync('/tmp/saas-fixtures/fail-finalization-once', '1');
  const interrupted = await purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-interrupted', action: 'use_now' });
  assert.equal(interrupted.status, 500, 'injected interrupted finalization');
  const interruptedLedger = await db.collection('extensionwallettransactions').findOne({ twitchTransactionID: 'tx-interrupted' });
  const stableID = `bits-${interruptedLedger._id}`;
  await wait(() => overlay.triggers.some(t => t.triggerID === stableID), 'interrupted purchase reached durable queue');
  overlay.ack(stableID);
  await wait(async () => (await db.collection('dimafxplaybacks').findOne({ _id: stableID })).state === 'completed', 'job completion persisted');
  await db.collection('extensionwallettransactions').updateOne({ _id: interruptedLedger._id }, { $set: { updatedAt: new Date(Date.now() - 31000) } });
  const retries = await Promise.all(Array.from({ length: 5 }, () => purchase(String(videoItem), { sku: 'dimafx_bits_5', transactionID: 'tx-interrupted', action: 'use_now' })));
  assert.ok(retries.every(r => r.status === 200), JSON.stringify(retries));
  assert.equal(await db.collection('dimafxplaybacks').countDocuments({ _id: stableID }), 1, 'one durable job for concurrent retries');
  assert.equal((await db.collection('dimafxplaybacks').findOne({ _id: stableID })).state, 'completed', 'retry does not reset terminal job');

  // Saving is also idempotent if finalization is interrupted.
  fs.writeFileSync('/tmp/saas-fixtures/fail-finalization-once', '1');
  const saveBody = { sku: 'dimafx_bits_5', transactionID: 'tx-save-interrupted', action: 'save', userID: 'saved-viewer' };
  assert.equal((await purchase(String(videoItem), saveBody)).status, 500);
  await db.collection('extensionwallettransactions').updateOne({ twitchTransactionID: saveBody.transactionID }, { $set: { updatedAt: new Date(Date.now() - 31000) } });
  assert.equal((await purchase(String(videoItem), saveBody)).status, 200);
  const saved = await db.collection('userextensioninventories').findOne({ channelID: channel, userID: 'saved-viewer' });
  assert.equal(saved.items.reduce((sum, row) => sum + row.quantity, 0), 1, 'saved item not duplicated');

  // Interrupted job survives >1h offline and a stale producer lease.
  const recoverID = 'fixture-recovered-job';
  await db.collection('dimafxplaybacks').insertOne({
    _id: recoverID, channelID: channel, state: 'playing', leaseOwner: 'dead-process', leaseUntil: new Date(0),
    createdAt: new Date(Date.now() - 7200000), updatedAt: new Date(),
    payload: { triggerID: recoverID, channelID: channel, itemID: String(videoItem), name: 'Recovered', category: 'video', mediaUrl: 'https://api.domdimabot.com/media/fixture', mediaType: 'video/mp4', volume: 80, durationMs: 2000, source: 'bits_purchase', enqueuedAt: Date.now() - 7200000 },
  });
  await wait(() => overlay.triggers.some(t => t.triggerID === recoverID), 'stale claimed job recovered');
  overlay.ack(recoverID);
  await wait(async () => (await db.collection('dimafxplaybacks').findOne({ _id: recoverID })).state === 'completed', 'recovered job completes');

  // A real API child is killed during synthesis, then restarted against the
  // same disposable data. This does not restart the candidate or any live service.
  const childChannel = '999982';
  await redis.hSet(`accounts:twitch:${childChannel}:data`, { id: childChannel, name: 'dimafx-restart', plan_tier: 'premium' });
  const childItem = new mongoose.Types.ObjectId();
  await db.collection('channelextensionitems').insertOne({ ...baseItem, _id: childItem, channelID: childChannel, assetID: null, name: 'Restart TTS', category: 'tts', mediaType: 'audio', durationMs: 0, bitsPrice: 0, sku: 'free', tts: { mode: 'custom', text: '', voice: 'en_US-ryan-medium', language: 'en' } });
  const childSource = `
    await import('/app/dist/utils/databases/mongodb.database.js').then(m => m.getMongoDBConnection('fixture-child'));
    const { server } = await import('/app/dist/server/server.js');
    const { websocket } = await import('/app/dist/server/websocket.js');
    const http = await websocket(await server()); http.listen(4001, '127.0.0.1');
  `;
  const startChild = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], { env: process.env, stdio: ['ignore', fs.openSync('/tmp/saas-fixtures/child-api.log', 'a'), fs.openSync('/tmp/saas-fixtures/child-api.log', 'a')] });
    children.push(child);
    await wait(async () => { try { return (await fetch('http://127.0.0.1:4001/extensions/dimafx/internal/channels/999982/overlay-status', { headers: serviceHeaders })).ok; } catch { return false; } }, 'child API startup');
    return child;
  };
  const child = await startChild();
  const childOverlay = await connectOverlay({ port: 4001, id: childChannel });
  await wait(async () => (await fetch(`http://127.0.0.1:4001/extensions/dimafx/internal/channels/${childChannel}/overlay-status`, { headers: serviceHeaders }).then(r => r.json())).data.connected, 'child overlay ready');
  const childPurchase = await fetch(`http://127.0.0.1:4001/extensions/dimafx/internal/channels/${childChannel}/items/${childItem}/purchase`, {
    method: 'POST', headers: serviceHeaders, body: JSON.stringify({ sku: 'free', transactionID: 'tx-restart', action: 'use_now', ttsText: 'RESTART_PENDING speech' }),
  }).then(r => r.json());
  assert.equal(childPurchase.error, false, JSON.stringify(childPurchase));
  const childTriggerID = childPurchase.data.triggerID;
  await wait(() => fs.readFileSync('/tmp/saas-fixtures/provider-calls.jsonl', 'utf8').includes('RESTART_PENDING'), 'synthesis began before crash');
  assert.equal(childOverlay.triggers.length, 0, 'kill before any playback dispatch');
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  await startChild();
  const replacement = await connectOverlay({ port: 4001, id: childChannel });
  await wait(() => replacement.triggers.some(t => t.triggerID === childTriggerID), 'accepted purchase recovered after actual process restart');
  replacement.ack(childTriggerID);
  await wait(async () => (await db.collection('dimafxplaybacks').findOne({ _id: childTriggerID })).state === 'completed', 'restarted playback completed');
  assert.equal(await db.collection('dimafxplaybacks').countDocuments({ _id: childTriggerID }), 1);

  // Offline credit/save/redeem attempts have no inventory side effects.
  overlay.ws.close();
  await wait(async () => !(await overlayStatus()).data.connected, 'offline purchase gating');
  for (const action of ['use_now', 'save']) {
    const credit = await fetch(`${root}/extensions/dimafx/internal/channels/${channel}/items/${videoItem}/use-credit`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ userID: 'viewer-1', action }) });
    assert.equal(credit.status, 409);
  }
  const redeem = await fetch(`${root}/extensions/dimafx/internal/channels/${channel}/items/${videoItem}/redeem`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ userID: 'saved-viewer' }) });
  assert.equal(redeem.status, 409);
  assert.equal((await db.collection('userextensioninventories').findOne({ channelID: channel, userID: 'viewer-1' })).balance, 5);
  assert.equal((await db.collection('userextensioninventories').findOne({ channelID: channel, userID: 'saved-viewer' })).items[0].quantity, 1);

  console.log('PASS: isolated DimaFX socket/auth/ready gating, queue/acks/TTS, actual process restart during synthesis, interrupted fulfillment + concurrent retries, saved-item idempotency, durable stale-job recovery, offline inventory protection');
} finally {
  if (fs.existsSync('/tmp/saas-fixtures/child-api.log')) console.log(fs.readFileSync('/tmp/saas-fixtures/child-api.log', 'utf8').slice(-3000));
  for (const ws of sockets) ws.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  await redis.quit();
  await mongoose.disconnect();
}
