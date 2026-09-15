import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
const channel = '999991';
const token = 'saas-ops-fish-test';
const root = 'http://127.0.0.1:3000';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
await redis.hSet(`token:${token}`, { id: channel, login: 'test', display_name: 'Test' });
await redis.hSet(`token:${token}-other`, { id: '999992', login: 'other', display_name: 'Other' });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'test', polar_sh_customer_id: 'test-customer', plan_tier: 'premium' });
const setCredits = async balance => redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: balance, balance, available: true, status: balance > 0 ? 'available' : 'exhausted' }));
await setCredits(10000);
const request = async (path, method = 'GET', body, auth = headers) => {
  const response = await fetch(root + path, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
};
const catalog = '/speech/voices/' + channel;
assert.equal((await request(catalog, 'GET', null, {})).status, 401);
assert.equal((await request(catalog, 'GET', null, { Authorization: `Bearer ${token}-other` })).status, 403);
assert.equal((await request(catalog + '?page=0')).status, 400);
assert.equal((await request(catalog + '?gender=invalid')).status, 400);
let result = await request(catalog + '?name=Alice&gender=female&language=en&license=licensed');
assert.equal(result.status, 200); assert.deepEqual(result.body.data.items.map(v => v.id), ['a'.repeat(32)]);
result = await request(catalog + '?gender=female&language=en&license=unlicensed');
assert.deepEqual(result.body.data.items.map(v => v.id), ['b'.repeat(32)]);
result = await request(catalog + '?gender=male&language=es');
assert.deepEqual(result.body.data.items.map(v => v.id), ['c'.repeat(32)]);
result = await request(catalog + '?page=2'); assert.equal(result.body.data.hasMore, false);
assert.equal((await request(catalog + '?name=outage')).status, 503);
const calls = () => fs.readFileSync('/tmp/saas-fixtures/provider-calls.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const searchCall = calls().find(c => c.url?.includes('title=Alice'));
assert.ok(searchCall.url.includes('tag=female')); assert.ok(searchCall.url.includes('licensed=true')); assert.ok(searchCall.url.includes('language=en'));
const settingsUrl = '/speech/settings/' + channel;
const settings = (await request(settingsUrl)).body.data.settings;
settings.provider = 'fish'; settings.voices.cloneDefault = 'b'.repeat(32);
assert.equal((await request(settingsUrl, 'PUT', settings)).status, 200);
assert.equal((await request(settingsUrl)).body.data.settings.voices.cloneDefault, 'b'.repeat(32));
settings.voices.cloneDefault = '0'.repeat(32); assert.equal((await request(settingsUrl, 'PUT', settings)).status, 404);
settings.voices.cloneDefault = 'constructor'; assert.equal((await request(settingsUrl, 'PUT', settings)).status, 400);
assert.equal((await request('/speech/preview-session/' + channel, 'POST', {}, { Authorization: `Bearer ${token}-other` })).status, 403);
const ticket = async () => (await request('/speech/preview-session/' + channel, 'POST', {})).body.data.ticket;
const sockets = [];
async function connect(ticket, id = channel, kind = 'speech-preview') {
  const namespace = '/' + kind + '/' + id;
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  const messages = [];
  ws.addEventListener('message', event => {
    const m = String(event.data);
    if (m === '2') ws.send('3');
    else if (m.startsWith('0')) ws.send(`40${namespace},${JSON.stringify({ ticket })}`);
    else messages.push(m);
  });
  const wait = async prefix => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(m => m.startsWith(prefix));
      if (index >= 0) return messages.splice(index, 1)[0];
      if (messages.some(m => m.startsWith('44'))) throw new Error('unauthorized');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('socket timeout ' + prefix);
  };
  await wait(`40${namespace},`);
  let sequence = 0;
  return { ws, wait, send: async body => {
    const id = ++sequence;
    ws.send(`42${namespace},${id}${JSON.stringify(['preview', body])}`);
    const prefix = `43${namespace},${id}`;
    const response = await wait(prefix);
    return JSON.parse(response.slice(prefix.length))[0];
  } };
}
await assert.rejects(connect('f'.repeat(64)), /unauthorized/);
const oneUse = await ticket(); const socket = await connect(oneUse);
await assert.rejects(connect(oneUse), /unauthorized/);
await assert.rejects(connect(await ticket(), '999992'), /unauthorized/);
assert.equal(await redis.exists(`twitch:${channel}:tts:connected`), 0, 'preview must not register as a live overlay');
assert.equal((await socket.send({ voiceId: 'invalid', language: 'en' })).code, 'invalid_voice');
const cooldown = async () => {
  const deadline = Date.now() + 5000;
  while (await redis.exists(`tts:preview:lock:${channel}`)) {
    assert.ok(Date.now() < deadline, 'Preview lock not released');
    await new Promise(r => setTimeout(r, 10));
  }
  await redis.del(`tts:preview:cooldown:${channel}`);
};
await cooldown(); await setCredits(1);
const synthCount = () => calls().filter(c => c.synthesis).length;
const count = synthCount();
assert.equal((await socket.send({ voiceId: 'b'.repeat(32), language: 'en' })).code, 'insufficient_credits');
assert.equal(synthCount(), count);
await cooldown(); await setCredits(10000);
fs.writeFileSync('/tmp/saas-fixtures/state.json', JSON.stringify({ slow: true }));
const pending = socket.send({ voiceId: 'b'.repeat(32), language: 'es', text: 'user text must be ignored'.repeat(100) });
const other = await connect(await ticket());
assert.equal((await other.send({ voiceId: 'b'.repeat(32), language: 'en' })).code, 'preview_busy');
result = await pending;
assert.equal(result.error, false, JSON.stringify(result)); assert.ok(result.data.credits > 0 && result.data.credits <= 150);
assert.equal(result.data.credits, Math.ceil(result.data.text.length * 1.5)); assert.ok(Buffer.from(result.data.audio, 'base64').length > 100);
assert.equal(result.data.text.includes('user text'), false);
assert.equal(synthCount(), count + 1);
assert.equal(calls().filter(c => c.synthesis).at(-1).model, 's2.1-pro', 'primary backend must be the official s2.1-pro');
assert.equal(await redis.hGet(`${channel}:tts:usage`, 'fish_credits'), String(result.data.credits));
assert.equal(JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance, 10000 - result.data.credits);
assert.equal(await redis.exists(`twitch:${channel}:tts:processing`), 0);
assert.equal(await redis.exists(`twitch:${channel}:tts:queue`), 0);
assert.equal((await socket.send({ voiceId: 'b'.repeat(32), language: 'en' })).code, 'preview_busy');
await cooldown(); fs.writeFileSync('/tmp/saas-fixtures/state.json', JSON.stringify({ fail: true }));
const spent = await redis.hGet(`${channel}:tts:usage`, 'fish_credits');
const failCount = synthCount();
assert.equal((await socket.send({ voiceId: 'b'.repeat(32), language: 'en' })).code, 'synthesis_failed');
assert.deepEqual(calls().filter(c => c.synthesis).slice(failCount).map(c => c.model), ['s2.1-pro', 's2.1-pro-free'], 'failure must try s2.1-pro then fall back to s2.1-pro-free');
assert.equal(await redis.hGet(`${channel}:tts:usage`, 'fish_credits'), spent);
await cooldown();
assert.equal((await socket.send({ voiceId: '0'.repeat(32), language: 'en' })).code, 'voice_unavailable');
// The saved default and explicit tts.fish arguments are separate paths.
fs.writeFileSync('/tmp/saas-fixtures/state.json', '{}');
const overlay = await connect(undefined, channel, 'speech');
while (!await redis.exists(`twitch:${channel}:tts:connected`)) await new Promise(r => setTimeout(r, 10));
const finishSpeech = async expected => {
  const event = await overlay.wait(`42/speech/${channel},`);
  const [, payload] = JSON.parse(event.slice(`42/speech/${channel},`.length));
  const lastSynthesis = calls().filter(c => c.synthesis).at(-1);
  assert.equal(lastSynthesis.synthesis.reference_id, expected);
  assert.equal(lastSynthesis.model, 's2.1-pro', 'queued speech must use the official s2.1-pro backend');
  overlay.ws.send(`42/speech/${channel},${JSON.stringify(['speech-ended', { speechID: payload.speechID }])}`);
  const deadline = Date.now() + 5000;
  while (await redis.exists(`twitch:${channel}:tts:processing`)) {
    assert.ok(Date.now() < deadline, 'Speech completion timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};
for (const mode of ['speak', 'clone']) {
  const queued = await request('/speech/' + channel, 'POST', { mode, text: 'Normal speech', language: 'en' });
  assert.equal(queued.status, 200);
  await finishSpeech('b'.repeat(32));
}
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
await getMongoDBConnection('isolated Fish regression');
const { registerTtsFunctions } = await import('/app/dist/utils/ast_parser/functions/tts.functions.js');
const { getFunctionHandler, createExecutionContext } = await import('/app/dist/utils/ast_parser/evaluator.js');
registerTtsFunctions();
const fishHandler = getFunctionHandler('tts.fish');
for (const [argument, expected] of [['rias_gremory', 'a5711996953b4cfda57cb516e26fe1e0'], ['c'.repeat(32), 'c'.repeat(32)]]) {
  const result = await fishHandler([argument, 'Explicit voice test'], createExecutionContext({ broadcasterId: channel, userId: channel, userLogin: 'test' }));
  assert.equal(result, '');
  await finishSpeech(expected);
}
const { PREVIEW_PHRASES, choosePreviewPhrase } = await import('/app/dist/server/services/tts/fish_preview.service.js');
for (const language of ['en', 'es']) {
  assert.equal(PREVIEW_PHRASES[language].length, 5);
  for (const text of PREVIEW_PHRASES[language]) assert.ok(Math.ceil(text.length * 1.5) <= 150);
  for (let n = 0; n < 25; n++) assert.ok(PREVIEW_PHRASES[language].includes(choosePreviewPhrase(language).text));
}
const { resolveFishVoice } = await import('/app/dist/server/services/tts/fish_voice_catalog.service.js');
assert.equal(resolveFishVoice('gojo'), '7b5626abdaa044babfc3829ec15acf31');
assert.equal(resolveFishVoice('b'.repeat(32)), 'b'.repeat(32));
assert.equal(resolveFishVoice('constructor'), null);
for (const ws of sockets) ws.close();
await redis.quit();
console.log('Fish API: search filters, permissions, persistence, saved defaults, explicit tts.fish aliases/IDs, preview websocket, billing/cap, concurrency, provider failure and isolation passed.');
process.exit(0);
