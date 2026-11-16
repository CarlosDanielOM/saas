// Behavior check for real voice provider costs in Polar usage events (API candidate).
//
//   scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis \
//     --fixtures ops/checks/fish-fixtures --test-env ops/checks/fish-fixtures/test-env.json \
//     --check ops/checks/tts-provider-cost-api.mjs
//
// Voice previews go through the same billing path as stream speech. The fixture mocks OpenRouter
// (audio plus `x-generation-id`, like production), Fish and Polar; nothing leaves the candidate.
// - an OpenRouter line (Drama 3, Kokoro) waits in `tts_usage_pending` with its credits taken locally
//   and no Polar event or receipt yet: the cron `tts-usage` worker sends it once the cost is known;
// - a Fish direct (S2.1 Pro) line is sent at once with `_cost` = list price in cents, `cost` = the same in USD;
// - a Piper line is sent at once with `_cost`/`cost` 0; credits stay the fixed price throughout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '/app/dist/utils/tts_usage.test.js',
  '/app/dist/utils/tts/tts_provider_cost.test.js', '/app/dist/utils/polarsh_accounting.test.js', '/app/dist/utils/usage_receipt_path.test.js'], {
  env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit',
});

const require = createRequire('/app/package.json');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo', 'disposable Mongo only');
const redis = createClient({ url: 'redis://redis:6379' });
await redis.connect();
await mongoose.connect(process.env.MONGO_URI);
const pending = mongoose.connection.db.collection('tts_usage_pending');

const channel = '999991';
const customer = '11111111-1111-4111-8111-111111111111';
const token = 'saas-ops-tts-cost-test';
const root = 'http://127.0.0.1:3000';
await redis.hSet(`token:${token}`, { id: channel, login: 'test', display_name: 'Test' });
await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'test', polar_sh_customer_id: customer, plan_tier: 'premium' });
const setCredits = async balance => {
  await redis.del([`twitch:${channel}:ai:exhaust`, `${channel}:ai:exhaust`]);
  await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 10000, balance, available: true, status: balance > 0 ? 'available' : 'exhausted' }));
};
const balance = async () => JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance;
const logPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const usageEvents = () => calls().flatMap(call => call.body?.events || []).filter(event => event.name === 'ai_usage');
const queuedReceipts = async () => (await redis.lRange('cron:ai-usage-receipts:queue', 0, -1)).map(JSON.parse);
const state = value => fs.writeFileSync('/tmp/saas-fixtures/state.json', JSON.stringify(value));
const cents = (bytes, usdPerMillion) => Math.round(bytes * usdPerMillion / 1e6 * 100 * 1e8) / 1e8;

const ticket = async () => {
  const response = await fetch(`${root}/speech/preview-session/${channel}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  return (await response.json()).data.ticket;
};
const sockets = [];
async function connect(previewTicket) {
  const namespace = `/speech-preview/${channel}`;
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  sockets.push(ws);
  const messages = [];
  ws.addEventListener('message', event => {
    const m = String(event.data);
    if (m === '2') ws.send('3');
    else if (m.startsWith('0')) ws.send(`40${namespace},${JSON.stringify({ ticket: previewTicket })}`);
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
  return { send: async body => {
    const id = ++sequence;
    ws.send(`42${namespace},${id}${JSON.stringify(['preview', body])}`);
    const prefix = `43${namespace},${id}`;
    return JSON.parse((await wait(prefix)).slice(prefix.length))[0];
  } };
}
const cooldown = async () => {
  const deadline = Date.now() + 5000;
  while (await redis.exists(`tts:preview:lock:${channel}`)) {
    assert.ok(Date.now() < deadline, 'Preview lock not released');
    await new Promise(r => setTimeout(r, 10));
  }
  await redis.del(`tts:preview:cooldown:${channel}`);
};
const socket = await connect(await ticket());

// 1. Fish through OpenRouter Drama 3: parked, credits taken now, nothing in Polar or the receipts yet.
await cooldown(); await setCredits(10000); state({});
let result = await socket.send({ voiceId: 'b'.repeat(32), language: 'en' });
assert.equal(result.error, false, JSON.stringify(result));
assert.equal(result.data.credits, Math.ceil(result.data.text.length * 1.5), 'credits stay the fixed Fish price');
assert.equal(await balance(), 10000 - result.data.credits, 'credits are taken from the local balance at once');
let rows = await pending.find({ channelID: channel }).toArray();
assert.equal(rows.length, 1, 'the OpenRouter line waits for its cost');
const fishRow = rows[0];
assert.match(fishRow.generationId, /^gen-tts-fixture-/);
assert.equal(fishRow.backend, 'fish-audio/drama-3');
assert.equal(fishRow.provider, 'fish');
assert.equal(fishRow.customerId, customer);
assert.equal(fishRow.credits, result.data.credits);
assert.equal(fishRow.bytes, Buffer.byteLength(result.data.text, 'utf8'));
assert.equal(fishRow.nextAttemptAt.getTime() - fishRow.occurredAt.getTime(), 30000, 'first lookup after OpenRouter usually has the charge');
assert.equal(fishRow.usage.source, 'voice_preview');
assert.equal(fishRow.usage.receipt.model, 'fish-audio/drama-3');
assert.equal(usageEvents().filter(event => event.metadata.reason === 'tts_fish').length, 0, 'no Polar event before the real cost is known');
assert.equal((await queuedReceipts()).filter(receipt => receipt.id === fishRow.entryId).length, 0, 'the receipt is written with the event');

// 2. Fish direct S2.1 Pro fallback: Fish reports no cost, so it is sent at once with the list price.
await cooldown(); state({ failModel: 'fish-audio/drama-3' });
const before = await balance();
result = await socket.send({ voiceId: 'b'.repeat(32), language: 'en' });
assert.equal(result.error, false, JSON.stringify(result));
assert.equal(calls().filter(call => call.synthesis).at(-1).model, 's2.1-pro');
assert.equal(await pending.countDocuments({ channelID: channel }), 1, 'no wait for Fish direct');
const sentText = calls().filter(call => call.synthesis).at(-1).synthesis.text;
const directEvent = usageEvents().filter(event => event.metadata.reason === 'tts_fish').at(-1);
assert.ok(directEvent, 'Fish direct usage reaches Polar at once');
const expected = cents(Buffer.byteLength(sentText, 'utf8'), 15);
assert.equal(Number(directEvent.metadata._cost.amount), expected, '_cost is the real cost in cents');
assert.equal(directEvent.metadata._cost.currency, 'usd');
assert.equal(directEvent.metadata.cost, Math.round(Buffer.byteLength(sentText, 'utf8') * 15 / 1e6 * 1e10) / 1e10, 'cost is the same charge in USD');
assert.equal(directEvent.metadata.credits, result.data.credits, 'credits stay the fixed price');
assert.equal(directEvent.metadata.usage_source, 'voice_preview');
assert.equal(await balance(), before - result.data.credits, 'charged once');
const directReceipt = (await queuedReceipts()).find(receipt => receipt.id === directEvent.metadata.entry_id);
assert.equal(directReceipt.costUsd, Math.round(expected / 100 * 1e10) / 1e10, 'the receipt carries the same cost in USD');
assert.equal(directReceipt.model, 's2.1-pro');

// 3. Kokoro also goes through OpenRouter: parked the same way.
await cooldown(); await setCredits(10000); state({});
result = await socket.send({ provider: 'kokoro', voiceId: 'af_heart', language: 'en' });
assert.equal(result.error, false, JSON.stringify(result));
assert.equal(await balance(), 10000 - result.data.credits);
rows = await pending.find({ channelID: channel, provider: 'kokoro' }).toArray();
assert.equal(rows.length, 1);
assert.equal(rows[0].backend, 'hexgrad/kokoro-82m');
assert.equal(rows[0].credits, result.data.credits);
assert.equal(usageEvents().filter(event => event.metadata.reason === 'tts_kokoro').length, 0);

// 4. Piper runs on our host: sent at once, real cost 0, credits as before.
await cooldown(); await setCredits(0);
result = await socket.send({ provider: 'piper', voiceId: 'en_US-ryan-medium', language: 'en' });
assert.equal(result.error, false, JSON.stringify(result));
const piperEvent = usageEvents().filter(event => event.metadata.reason === 'tts_piper').at(-1);
assert.equal(Number(piperEvent.metadata._cost.amount), 0);
assert.equal(piperEvent.metadata.cost, 0);
assert.equal(piperEvent.metadata.credits, result.data.credits);
assert.equal(await pending.countDocuments({ channelID: channel, provider: 'piper' }), 0);

for (const ws of sockets) ws.close();
await mongoose.disconnect();
await redis.quit();
console.log('PASS voice provider cost: OpenRouter lines wait in tts_usage_pending with credits taken locally; Fish direct and Piper send real cost at once (_cost cents, cost USD); credits unchanged.');
