import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const suites = process.env.SAAS_TARGET === 'api' ? [
  'dist/handlers/tts_controls.test.js', 'dist/handlers/tts_queue_credits.test.js',
  'dist/utils/ast_parser/tts_controls.test.js', 'dist/utils/ast_parser/tts_settings.test.js',
  'dist/utils/ast_parser/set_voice.test.js'
] : ['dist/utils/ast_parser/tts_controls.test.js'];
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test-force-exit', '--test', ...suites],
  { stdio: 'inherit', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '' } });
const html = readFileSync('/app/dist/server/routes/public/speech.html', 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)[1];
const handlers = {}, outbound = [], downloads = [];
const sandbox = { console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  window: { location: { pathname: '/speech/999991', reload() { assert.fail('recovery must work with already-open overlay code'); } } },
  io: () => ({ on: (event, handler) => handlers[event] = handler, emit: (...args) => outbound.push(args) }),
  fetch: (url, { signal }) => new Promise((resolve, reject) => { downloads.push({ url, signal }); signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
};
vm.runInNewContext(script, sandbox);
handlers['speech-reset']();
handlers.speech({ speechID: 'a', audioUrl: '/a.wav' });
handlers.speech({ speechID: 'b', audioUrl: '/b.wav' });
assert.equal(downloads.length, 1);
handlers['speech-reset']();
assert.ok(downloads[0].signal.aborted);
assert.equal(downloads.length, 1, 'reset discards the local backlog');
handlers.speech({ speechID: 'c', audioUrl: '/c.wav' });
handlers.disconnect();
assert.ok(downloads[1].signal.aborted);
assert.equal(outbound.filter(([event]) => event === 'speech-ended').length, 0, 'server initiated cancellation sends no stale completion');

const catalog = JSON.parse(readFileSync('/app/src/utils/ai/ast_catalog/ast-catalog.json', 'utf8'));
for (const action of ['skip', 'clear', 'refresh']) assert.equal(catalog.entries.find(e => e.name === 'tts.' + action).minUserLevel, 7);
for (const name of ['tts.status', 'tts.connected', 'tts.queue.length']) assert.equal(catalog.entries.find(e => e.name === name).minUserLevel, 1);

const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { registerTtsFunctions } = await import('/app/dist/utils/ast_parser/functions/tts.functions.js');
const { parse } = await import('/app/dist/utils/ast_parser/parser.js');
const { evaluate, createExecutionContext } = await import('/app/dist/utils/ast_parser/evaluator.js');
await getMongoDBConnection('tts-control-check');
const redis = await getDragonflyClient('tts-control-check');
const channel = '999991';
await Users.collection.insertOne({ accounts: [{ type: 'twitch', id: channel }], plan_tier: 'free' });
await redis.hSet('token:tts-owner', { id: channel, login: 'fixture' });
await redis.hSet('token:tts-other', { id: '999992', login: 'other' });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'fixture', plan_tier: 'free', access_token: 'tts-owner', expires_at: String(Math.floor(Date.now() / 1000) + 36000) });
const request = async (action, status = 200, token = 'tts-owner') => {
  const response = await fetch(`http://127.0.0.1:3000/speech/${channel}/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ action }) });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
};
const readStatus = async (status = 200, token = 'tts-owner', targetChannel = channel) => {
  const response = await fetch(`http://127.0.0.1:3000/speech/${targetChannel}/status`, {
    headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  if (status === 200) assert.match(response.headers.get('cache-control') || '', /no-store/); return body.data;
};
if (process.env.SAAS_TARGET === 'api') {
  await readStatus(401, '');
  await readStatus(403, 'tts-other');
  await readStatus(400, 'tts-owner', 'invalid');
  assert.deepEqual(await readStatus(), { connected: false, playing: false, preparing: false, queueLength: 0 });
  const { AdminSchema } = await import('/app/dist/schemas/admin.schema.js');
  await AdminSchema.collection.insertOne({ channelID: channel, adminID: '999993', actived: true, permissions: ['tts:view'] });
  await redis.hSet('token:tts-reader', { id: '999993', login: 'reader' });
  await readStatus(200, 'tts-reader');
  await request('clear', 403, 'tts-reader');
  await request('clear', 401, '');
  await request('clear', 403, 'tts-other');
  await request('delete', 400);
  await request(['skip'], 400);
  // Exercise the real API queue and sockets without synthesizing paid speech.
  const ns = `/speech/${channel}`, messages = [];
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  ws.addEventListener('message', event => { const m = String(event.data);
    if (m === '2') ws.send('3'); else if (m.startsWith('0')) ws.send(`40${ns},{}`);
    else if (m.startsWith(`42${ns},`)) messages.push(JSON.parse(m.slice(`42${ns},`.length))); });
  const until = async condition => { for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail('socket condition timeout'); };
  await until(() => messages.some(([e]) => e === 'speech-reset'));
  assert.equal((await readStatus()).connected, true);
  const resets = messages.filter(([e]) => e === 'speech-reset').length;
  await request('skip');
  await until(() => messages.filter(([e]) => e === 'speech-reset').length > resets);
  await redis.zAdd(`twitch:${channel}:tts:queue`, { score: 1, value: 'queued-to-clear' });
  await redis.set(`twitch:${channel}:tts:queue:data:queued-to-clear`, '{}');
  assert.equal((await readStatus()).queueLength, 1);
  assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`), 1, 'status must not consume queued speech');
  await request('clear');
  assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`), 0);
  assert.equal(await redis.exists(`twitch:${channel}:tts:queue:data:queued-to-clear`), 0);
  let closed = false; ws.addEventListener('close', () => { closed = true; });
  await request('refresh'); await until(() => closed);
  ws.close();
  const studioRequest = async (method, path, body, status = 200) => {
    const response = await fetch('http://127.0.0.1:3000/overlay-studio/' + path, { method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tts-owner' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json(); assert.equal(response.status, status, JSON.stringify(envelope)); return envelope.data;
  };
  let state = await studioRequest('GET', channel);
  state = await studioRequest('POST', `${channel}/scenes/${state.scenes[0].id}/publish`, { revision: state.revision });
  const scene = state.scenes[0], studioNs = '/overlay-studio/' + scene.publicId;
  const connect = async (clientId = 'tts-controls-fixture') => {
    const received = [], socket = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
    socket.addEventListener('message', event => { const m = String(event.data);
      if (m === '2') socket.send('3'); else if (m.startsWith('0')) socket.send(`40${studioNs},${JSON.stringify({ clientId })}`);
      else if (m.startsWith(`42${studioNs},`)) received.push(JSON.parse(m.slice(`42${studioNs},`.length))); });
    await until(() => received.some(([name]) => name === 'overlay-state'));
    return { socket, received, send: (event, body) => socket.send(`42${studioNs},${JSON.stringify([event, body])}`) };
  };
  let client = await connect();
  const duplicate = await connect('tts-status-second-source');
  // One request can be in the legacy player and Studio at once. Its Studio
  // handoff must not be counted again as a waiting message.
  const producerMessages = [], producerSocket = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  producerSocket.addEventListener('message', event => { const m = String(event.data);
    if (m === '2') producerSocket.send('3'); else if (m.startsWith('0')) producerSocket.send(`40${ns},{}`);
    else if (m.startsWith(`42${ns},`)) producerMessages.push(JSON.parse(m.slice(`42${ns},`.length))); });
  await until(() => producerMessages.some(([event]) => event === 'speech-reset'));
  const speechResponse = await fetch(`http://127.0.0.1:3000/speech/${channel}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'speak', provider: 'piper', text: 'Read-only status fixture', language: 'en' }) });
  assert.equal(speechResponse.status, 200, await speechResponse.text());
  await until(() => producerMessages.some(([event]) => event === 'speech'));
  assert.deepEqual(await readStatus(), { connected: true, playing: true, preparing: false, queueLength: 0 });
  await request('clear'); producerSocket.close();
  const testEvent = async kind => {
    await redis.del(`overlay:test:${channel}`);
    const count = client.received.filter(([e]) => e === 'overlay-event').length;
    await studioRequest('POST', `${channel}/test`, { kind, destination: 'obs', sceneId: scene.id, confirmed: true });
    await until(() => client.received.filter(([e]) => e === 'overlay-event').length > count);
    return client.received.filter(([e]) => e === 'overlay-event').at(-1)[1].id;
  };
  const playing = await testEvent('tts'), waiting = await testEvent('tts'), alert = await testEvent('follow');
  client.send('overlay-playback', { active: [playing, alert], queued: [waiting] });
  duplicate.send('overlay-playback', { active: [playing, alert], queued: [waiting] });
  await until(async () => (await studioRequest('GET', channel + '/queue')).needsRefresh === 0);
  await until(async () => (await studioRequest('GET', channel + '/queue')).events.some(e => e.id === playing && e.status === 'playing'));
  assert.deepEqual(await readStatus(), { connected: true, playing: true, preparing: false, queueLength: 1 });
  await request('skip');
  await studioRequest('GET', `public/${scene.publicId}/events/${playing}`, undefined, 404);
  await studioRequest('GET', `public/${scene.publicId}/events/${waiting}`);
  await studioRequest('GET', `public/${scene.publicId}/events/${alert}`);
  await until(() => client.received.some(([e, ids]) => e === 'overlay-expired' && ids.includes(playing)));
  await request('clear');
  await studioRequest('GET', `public/${scene.publicId}/events/${waiting}`, undefined, 404);
  await studioRequest('GET', `public/${scene.publicId}/events/${alert}`);
  const interrupted = await testEvent('tts'), retained = await testEvent('tts');
  client.send('overlay-playback', { active: [interrupted, alert], queued: [retained] });
  duplicate.send('overlay-playback', { active: [interrupted, alert], queued: [retained] });
  await until(async () => (await studioRequest('GET', channel + '/queue')).events.some(e => e.id === interrupted && e.status === 'playing'));
  let studioClosed = false; client.socket.addEventListener('close', () => { studioClosed = true; });
  await request('refresh'); await until(() => studioClosed);
  client = await connect();
  const pending = client.received.find(([e]) => e === 'overlay-state')[1].pendingIds;
  assert.ok(pending.includes(retained)); assert.ok(pending.includes(alert)); assert.ok(!pending.includes(interrupted));
  client.socket.close(); duplicate.socket.close();
  console.log('PASS Studio: skip active TTS, clear queued TTS, preserve alerts, refresh reconnect and durable waiting deliveries');
} else {
  // The normal bot/cron entrypoint is running; use a local authenticated API stub
  // to verify transport from their shared AST implementation.
  const { createServer } = await import('node:http');
  globalThis.ttsControlCalls = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === `/speech/${channel}/status`) {
      assert.equal(req.headers.authorization, 'Bearer tts-owner');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: false, data: { connected: true, playing: false, preparing: false, queueLength: 2 } }));
      return;
    }
    assert.equal(req.url, `/speech/${channel}/control`);
    assert.equal(req.headers.authorization, 'Bearer tts-owner');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.ok(['skip', 'clear', 'refresh'].includes(JSON.parse(body).action));
    globalThis.ttsControlCalls.push(JSON.parse(body).action);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: false, message: 'OK' }));
  });
  await new Promise(resolve => server.listen(3000, '127.0.0.1', resolve));
  globalThis.ttsControlServer = server;
}
registerTtsFunctions();
for (const action of ['skip', 'clear', 'refresh']) {
  const source = parse(`$(tts.${action})`).ast;
  const ctx = createExecutionContext({ broadcasterId: channel, userLevel: 7, platform: 'twitch' });
  assert.equal((await evaluate(source, ctx)).value, '');
  ctx.userLevel = 1;
  assert.match(String((await evaluate(source, ctx)).value), /permission denied/i);
}
const realFetch = globalThis.fetch;
try {
  const { getTtsStatus } = await import('/app/dist/functions/chats/control_tts.chat.js');
  for (const data of [null, { connected: 'false', playing: false, preparing: false, queueLength: 0 },
    { connected: true, playing: false, preparing: false, queueLength: -1 }]) {
    globalThis.fetch = async () => Response.json({ error: false, data });
    assert.equal((await getTtsStatus(channel)).error, true, 'malformed status must never become a valid boolean or count');
  }
  globalThis.fetch = async () => { throw new Error('fixture disconnected'); };
  const context = createExecutionContext({ broadcasterId: channel, userLevel: 1, platform: 'twitch' });
  assert.equal((await evaluate(parse('*($(tts.connected) ? "online" : "offline")').ast, context)).value, 'offline');
  assert.equal((await evaluate(parse('$(tts.queue.length)').ast, context)).value, '-1');
} finally { globalThis.fetch = realFetch; }
for (const name of ['tts.status', 'tts.connected', 'tts.queue.length']) {
  const context = createExecutionContext({ broadcasterId: channel, userLevel: 1, platform: 'twitch' });
  const output = (await evaluate(parse(`$(${name})`).ast, context)).value;
  if (name === 'tts.status') assert.match(String(output), /^TTS: (connected|disconnected)/);
  else if (name === 'tts.connected') assert.ok(['true', 'false'].includes(String(output)));
  else assert.ok(Number(output) >= 0);
}
if (process.env.SAAS_TARGET === 'bot') {
  const { scheduleAstTimer } = await import('/app/dist/utils/ast_timer_runtime.js');
  const before = globalThis.ttsControlCalls.length;
  await scheduleAstTimer(1, parse('*($(tts.connected) ? $(tts.skip) : "")').ast, createExecutionContext({ broadcasterId: channel, userLevel: 7, platform: 'twitch', userPlan: 'free' }));
  for (let i = 0; i < 100 && globalThis.ttsControlCalls.length === before; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(globalThis.ttsControlCalls.length, before + 1, 'real bot scheduler executes new TTS AST');
} else if (process.env.SAAS_TARGET === 'cron') {
  const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
  const { renderTimerMessage } = await import('/app/dist/utils/timer_runtime.js');
  await renderTimerMessage({ channelID: channel, streamerName: 'fixture', timerName: 'tts-control', message: '*($(tts.connected) ? $(tts.refresh) : "")', planTier: 'free', parse: parseSpecialCommands });
  assert.equal(globalThis.ttsControlCalls.at(-1), 'refresh', 'actual cron timer renderer uses new AST transport');
}
console.log(`PASS ${process.env.SAAS_TARGET}: compiled AST/queue regressions, cancellation receiver, catalog, authenticated transport and moderator gates`);
process.exit(0);
