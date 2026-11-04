import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { Server } from 'socket.io';
import { WebSocket } from 'ws';

// A deterministic Redis boundary exercises the actual Socket.IO acknowledgement
// and coordinator state machine; exact Redis Lua runs in the candidate check.
const entries = new Map<string, string>();
let revision = 0;
const cache = {
  get: async (key: string) => entries.get(key) ?? null,
  eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
    const [key, revKey] = options.keys, args = options.arguments;
    const raw = entries.get(key), item = raw ? JSON.parse(raw) : null;
    const next = () => { entries.set(revKey, String(++revision)); return revision; };
    if (script.includes("return {redis.call('GET'")) return [raw ?? '', entries.get(revKey) ?? '0'];
    if (script.includes("redis.call('EXISTS'")) { if (raw) return 0; entries.set(key, args[0]); return next(); }
    if (script.includes("local proof=cjson.decode(ARGV[2])")) {
      if (!item || item.fence !== args[0]) return [0, ''];
      const proof = JSON.parse(args[1]);
      if (!item.retiredProof || item.retiredProof.kind !== 'pet' || proof.kind === 'pet') item.retiredProof = proof;
      item.expiresAt = Math.min(item.expiresAt, Number(args[2]));
      const updated = JSON.stringify(item); entries.set(key, updated); return [next(), updated];
    }
    if (script.includes('item.fence == ARGV[1] then')) {
      if (item?.fence === args[0] && item.expiresAt > Number(args[1])) return [0, ''];
      if (item?.fence === args[0]) entries.delete(key);
      return [next(), item?.fence === args[0] ? raw : args[2]];
    }
    if (script.includes('item.expiresAt) > tonumber(ARGV[1])')) {
      if (!item || item.expiresAt > Number(args[0])) return [0, ''];
      entries.delete(key); return [next(), raw];
    }
    if (script.includes("item.phase='playing'")) {
      if (!item || item.fence !== args[0] || item.expiresAt <= Number(args[1])) return 0;
      if (item.phase === 'playing') return -1;
      item.phase = 'playing'; entries.set(key, JSON.stringify(item)); return next();
    }
    if (script.includes("item.phase ~= 'playing'")) {
      if (!item || item.fence !== args[0] || item.phase !== 'playing') return 0;
      if (item.expiresAt >= Number(args[1])) return -1;
      item.expiresAt = Number(args[1]); entries.set(key, JSON.stringify(item)); return next();
    }
    if (script.includes("return {0,''}")) {
      if (!item || item.fence !== args[0]) return [0, ''];
      entries.delete(key); return [next(), raw];
    }
    throw new Error('unexpected script');
  },
};
const turnListeners = new Set<(update: any) => void>();
mock.module('./updates.js', { namedExports: { TURN_STATUS_FEATURE: 'turn-status-v1',
  subscribeTurnUpdates: (listener: (update: any) => void) => { turnListeners.add(listener); return () => turnListeners.delete(listener); },
  refreshPetTurnUpdates: async () => {} } });
mock.module('../pets/wakeups.js', { namedExports: { subscribePetWakeups: () => () => {} } });
mock.module('./schema.js', { namedExports: { DesktopAiTurn: {} } });
let revoked = false;
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/oauth/service.js', { namedExports: { authenticateAccess: async (token: string) => {
  if (revoked || !['owner', 'other-session', 'no-ai', 'foreign-owner', 'foreign-client', 'foreign-channel'].includes(token)) throw new Error('invalid_token');
  return { session_id: token === 'other-session' ? 'other-session' : 'session-a', user_id: token === 'foreign-owner' ? 'owner-b' : 'owner-a',
    channel_id: token === 'foreign-channel' ? 'channel-b' : 'channel-a', client_id: token === 'foreign-client' ? 'another-client' : 'dima-desktop',
    scopes: ['desktop:connect', ...(token === 'no-ai' ? [] : ['pet:interact', 'ai:interact'])] };
} } });
const { registerDesktopSpeechActivity, prepareSpeechActivity, startSpeechActivity, finishSpeechActivity, retireMatchingSpeechActivity, confirmRetiredSpeechActivity, hasSafeDesktopPetStop } = await import('./activity.js');
const { petSocketAdapter } = await import('../pets/socket_adapter.js');

test('speech barrier, output serialization, fencing, reconnect snapshot and timeout failures', { timeout: 10_000 }, async t => {
  const http = createServer(), io = new Server(http, { adapter: petSocketAdapter, connectionStateRecovery: {} });
  const stop = registerDesktopSpeechActivity(io), clients: WebSocket[] = [];
  t.after(async () => { stop(); for (const client of clients) client.terminate(); await io.close(); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`); clients.push(ws);
  const changed = new EventEmitter(), packets: Array<{ name: string; data: any; ack?: string }> = [];
  ws.on('message', raw => {
    const frame = raw.toString();
    if (frame === '2') ws.send('3');
    else if (frame.startsWith('0')) ws.send('40/desktop-ai,{"v":1,"accessToken":"owner"}');
    else if (frame.startsWith('42/desktop-ai,')) {
      const body = frame.slice('42/desktop-ai,'.length), bracket = body.indexOf('[');
      const [name, data] = JSON.parse(body.slice(bracket)); packets.push({ name, data, ack: body.slice(0, bracket) || undefined }); changed.emit('packet');
    }
  });
  const until = async (condition: () => boolean) => {
    const signal = AbortSignal.timeout(3000);
    while (!condition()) await once(changed, 'packet', { signal });
  };
  await until(() => packets.some(p => p.name === 'speech:snapshot'));
  const firstSnapshot = packets.find(p => p.name === 'speech:snapshot')!.data;
  assert.deepEqual(firstSnapshot.active, []); assert.equal(typeof firstSnapshot.server_time, 'number');
  assert.equal(await hasSafeDesktopPetStop('channel-a', 'session-a'), true);
  assert.equal(await hasSafeDesktopPetStop('channel-a', 'older-session'), false, 'another or legacy session has no stop-proof capability');
  const input = { channelId: 'channel-a', playbackId: 'first', outputGeneration: 7, source: 'bot' as const, expiresAt: Date.now() + 30_000, requiredSessionId: 'session-a' };
  let resolved = false;
  const firstPending = prepareSpeechActivity(input).then(value => { resolved = true; return value; });
  await until(() => packets.some(p => p.name === 'speech:prepare'));
  const firstFrame = packets.find(p => p.name === 'speech:prepare')!;
  assert.equal(resolved, false, 'output cannot start before the microphone pause acknowledgement');
  assert.equal(firstFrame.data.phase, 'preparing'); assert.equal(typeof firstFrame.data.server_time, 'number');
  ws.send(`43/desktop-ai,${firstFrame.ack}${JSON.stringify([{ v: 1, playback_id: 'first', output_generation: 7, paused: true }])}`);
  const first = await firstPending; assert.ok(first);
  assert.equal(await startSpeechActivity(first), true);
  await until(() => packets.some(p => p.name === 'speech:started' && p.data.playback_id === 'first'));
  const reconnect = new WebSocket(`ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`); clients.push(reconnect);
  const resnapshot = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('missing reconnect snapshot')), 3000);
    reconnect.on('message', raw => {
      const frame = raw.toString();
      if (frame === '2') reconnect.send('3');
      else if (frame.startsWith('0')) reconnect.send('40/desktop-ai,{"v":1,"accessToken":"owner"}');
      else if (frame.startsWith('42/desktop-ai,')) {
        const payload = frame.slice('42/desktop-ai,'.length);
        const [name, data] = JSON.parse(payload.slice(payload.indexOf('[')));
        if (name === 'speech:snapshot') { clearTimeout(timer); resolve(data); }
      }
    });
  });
  const restored = await resnapshot;
  assert.equal(restored.active[0].playback_id, 'first'); assert.equal(restored.active[0].phase, 'playing');
  const disconnected = once(reconnect, 'close'); reconnect.terminate(); await disconnected;
  let secondResolved = false;
  const secondPending = prepareSpeechActivity({ ...input, playbackId: 'second', outputGeneration: 8 }).then(value => { secondResolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(secondResolved, false, 'another source cannot overlap the reserved output');
  const proof = { kind: 'pet' as const, ownerId: 'owner-a', peerId: 'peer-a', leaseId: 'lease-a', requestId: 'first', generation: 7 };
  assert.equal(await retireMatchingSpeechActivity('channel-a', 'first', 7, Date.now() + 1000, proof), true);
  assert.equal(await retireMatchingSpeechActivity('channel-a', 'first', 7, Date.now() + 2000, { kind: 'tts', source: 'pet' }), true);
  assert.equal(await confirmRetiredSpeechActivity('channel-a', { kind: 'tts', source: 'pet' }, 'first'), false, 'generic TTS cleanup cannot replace the Pet lease proof');
  assert.equal(await confirmRetiredSpeechActivity('channel-a', { ...proof, peerId: 'wrong-peer' }), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(secondResolved, false, 'a stop request and foreign ACK must not release the gate');
  assert.equal(await confirmRetiredSpeechActivity('channel-a', proof), true, 'only the original player stop releases the gate');
  await until(() => packets.some(p => p.name === 'speech:prepare' && p.data.playback_id === 'second'));
  const secondFrame = packets.find(p => p.name === 'speech:prepare' && p.data.playback_id === 'second')!;
  ws.send(`43/desktop-ai,${secondFrame.ack}${JSON.stringify([{ v: 1, playback_id: 'second', output_generation: 8, paused: true }])}`);
  const second = await secondPending; assert.ok(second);
  await finishSpeechActivity(first, 'late');
  assert.equal(JSON.parse(entries.get('desktop:speech:slot:channel-a')!).playbackId, 'second', 'stale terminal cannot release the new output');
  await finishSpeechActivity(second, 'cancelled');
  assert.equal(entries.has('desktop:speech:slot:channel-a'), false);
  await until(() => packets.some(p => p.name === 'speech:ended' && p.data.playback_id === 'second'));
  assert.equal(typeof packets.find(p => p.name === 'speech:ended')!.data.server_time, 'number');
  const expiring = prepareSpeechActivity({ ...input, playbackId: 'lease-expiry', outputGeneration: 10 });
  await until(() => packets.some(p => p.name === 'speech:prepare' && p.data.playback_id === 'lease-expiry'));
  const expiringFrame = packets.find(p => p.name === 'speech:prepare' && p.data.playback_id === 'lease-expiry')!;
  ws.send(`43/desktop-ai,${expiringFrame.ack}${JSON.stringify([{ v: 1, playback_id: 'lease-expiry', output_generation: 10, paused: true }])}`);
  const expiringHandle = await expiring; assert.ok(expiringHandle); assert.equal(await startSpeechActivity(expiringHandle), true);
  assert.equal(await retireMatchingSpeechActivity('channel-a', 'lease-expiry', 10, Date.now() + 150,
    { ...proof, requestId: 'lease-expiry', generation: 10 }), true);
  assert.equal(entries.has('desktop:speech:slot:channel-a'), true, 'the slot remains reserved while stop is unconfirmed');
  await until(() => packets.some(p => p.name === 'speech:ended' && p.data.playback_id === 'lease-expiry' && p.data.reason === 'expired'));
  assert.equal(entries.has('desktop:speech:slot:channel-a'), false, 'prior lease expiry eventually releases it');
  assert.equal(await prepareSpeechActivity({ ...input, channelId: 'channel-b', playbackId: 'missing' }), null, 'private Bot reply requires its originating session');
  const rejected = prepareSpeechActivity({ ...input, playbackId: 'bad-ack', outputGeneration: 9 });
  await until(() => packets.some(p => p.name === 'speech:prepare' && p.data.playback_id === 'bad-ack'));
  const rejectedFrame = packets.find(p => p.name === 'speech:prepare' && p.data.playback_id === 'bad-ack')!;
  ws.send(`43/desktop-ai,${rejectedFrame.ack}${JSON.stringify([{ v: 1, playback_id: 'bad-ack', output_generation: 9, paused: false }])}`);
  assert.equal(await rejected, null, 'a failed pause cancels that output');
  assert.equal(entries.has('desktop:speech:slot:channel-a'), false);
});


test('turn status hints require explicit capability, exact initiating identity and live target scopes', async t => {
  const http = createServer(), io = new Server(http);
  const stop = registerDesktopSpeechActivity(io), clients: WebSocket[] = [];
  t.after(async () => { revoked = false; stop(); for (const client of clients) client.terminate(); await io.close(); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  async function connect(token: string, features?: unknown) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`); clients.push(ws);
    const packets: any[] = []; const changed = new EventEmitter();
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('missing socket handshake')), 2000);
      ws.on('message', raw => {
        const frame = raw.toString();
        if (frame === '2') ws.send('3');
        else if (frame.startsWith('0')) ws.send(`40/desktop-ai,${JSON.stringify({ v: 1, accessToken: token, ...(features === undefined ? {} : { features }) })}`);
        else if (frame.startsWith('44/desktop-ai,')) { clearTimeout(timer); reject(new Error('unauthorized')); }
        else if (frame.startsWith('42/desktop-ai,')) {
          const [name, data] = JSON.parse(frame.slice('42/desktop-ai,'.length)); packets.push({ name, data }); changed.emit('packet');
          if (name === 'speech:snapshot') { clearTimeout(timer); resolve(); }
        }
      });
    });
    await ready; return { ws, packets, changed };
  }
  await assert.rejects(() => connect('owner', []), /unauthorized/);
  await assert.rejects(() => connect('owner', ['turn-status-v1', 'unknown']), /unauthorized/);
  const legacy = await connect('owner'), opted = await connect('owner', ['turn-status-v1']);
  const other = await connect('other-session', ['turn-status-v1']);
  const update = { turn: { _id: 'turn-a', requestId: 'request-a', sessionId: 'session-a', ownerId: 'owner-a',
    channelId: 'channel-a', clientId: 'dima-desktop', target: 'bot', text: 'private', speech: { ticket: 'secret' } }, revision: 100001 };
  for (const listener of turnListeners) listener(update);
  await once(opted.changed, 'packet', { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(opted.packets.at(-1), { name: 'ai:turn-updated', data: { v: 1, request_id: 'request-a', turn_id: 'turn-a', revision: 100001 } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(legacy.packets.length, 1); assert.equal(other.packets.length, 1);
  for (const mismatch of [{ ownerId: 'other' }, { sessionId: 'other' }, { clientId: 'other' }, { channelId: 'other' }]) {
    for (const listener of turnListeners) listener({ ...update, turn: { ...update.turn, ...mismatch } });
  }
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(opted.packets.length, 2);
  for (const listener of turnListeners) { listener({ ...update, revision: 300001 }); listener({ ...update, revision: 200001 }); listener({ ...update, revision: 300001 }); }
  await once(opted.changed, 'packet', { signal: AbortSignal.timeout(2000) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(opted.packets.length, 3, 'duplicate and reordered revisions never add extra invalidations');
  assert.equal(opted.packets.at(-1).data.revision, 300001);
  const closed = once(opted.ws, 'close'); opted.ws.terminate(); await closed;
  const noScope = await connect('no-ai', ['turn-status-v1']);
  for (const listener of turnListeners) listener(update);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(noScope.packets.length, 1);
  revoked = true;
  const before = other.packets.length;
  for (const listener of turnListeners) listener({ ...update, turn: { ...update.turn, sessionId: 'other-session' } });
  await once(other.ws, 'close', { signal: AbortSignal.timeout(2000) });
  assert.equal(other.packets.length, before, 'revoked tokens never receive a hint');
});
