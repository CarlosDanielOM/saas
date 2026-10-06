// Use kokoro-fixtures/api-env.json with disposable Mongo/Redis through saas-ops.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { upsertChannelTtsSettings } from '/app/dist/schemas/channel_tts_settings.schema.js';

assert.equal(process.env.SAAS_TARGET, 'api');
await getMongoDBConnection('PaidExhaustionCheck');
const redis = await getDragonflyClient('PaidExhaustionCheck');
const channel = '99119901';
const customer = '11111111-1111-4111-8111-111111111111';
await Users.create({ name: 'fixture', plan_tier: 'pro', polar_sh_customer_id: customer,
  accounts: [{ type: 'twitch', id: channel, name: 'fixture' }] });
await upsertChannelTtsSettings(channel, { provider: 'fish', voices: {
  en: 'en_US-ryan-medium', es: 'es_MX-ald-medium', kokoroDefault: 'af_bella',
} });
await redis.hSet('token:paid-exhaustion-fixture', { id: channel, login: 'fixture', display_name: 'Fixture' });

const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
const messages = [];
ws.addEventListener('message', event => {
  const message = String(event.data);
  if (message === '2') ws.send('3');
  else if (message.startsWith('0')) ws.send(`40/speech/${channel},`);
  else messages.push(message);
});
async function wait(prefix) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(message => message.startsWith(prefix));
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Socket timeout: ' + prefix);
}
await wait(`40/speech/${channel},`);
ws.send(`42/speech/${channel},${JSON.stringify(['speech-overlay-ready'])}`);
await new Promise(resolve => setTimeout(resolve, 100));
const calls = () => fs.existsSync('/tmp/saas-fixtures/calls.jsonl')
  ? fs.readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

try {
  const scenarios = [
    { plan: 'premium', provider: 'fish', expected: 'kokoro', voice: 'af_bella' },
    { plan: 'pro', provider: 'fish', expected: 'kokoro', voice: 'af_bella' },
    { plan: 'premium', provider: 'kokoro', expected: 'kokoro', voice: 'am_michael' },
    { plan: 'pro', provider: 'kokoro', expected: 'kokoro', voice: 'am_michael' },
    { plan: 'free', provider: 'fish', expected: 'piper' },
    { plan: 'free', provider: 'kokoro', expected: 'piper' },
    { plan: 'pro', provider: 'piper', expected: 'piper' },
    { plan: 'premium', provider: 'fish', expected: 'piper', fail: true },
    { plan: 'pro', provider: 'kokoro', expected: 'piper', fail: true },
    { plan: 'pro', provider: 'kokoro', expected: 'kokoro', voice: 'am_michael', available: true },
  ];
  for (const scenario of scenarios) {
    await redis.hSet(`accounts:twitch:${channel}:data`, {
      id: channel, name: 'fixture', plan_tier: scenario.plan, polar_sh_customer_id: customer,
    });
    await redis.del([`twitch:${channel}:ai:exhaust`, `${channel}:ai:exhaust`]);
    await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3,
      used: scenario.available ? 0 : 10000, limit: 10000, balance: scenario.available ? 10000 : 0,
      available: true, status: scenario.available ? 'available' : 'exhausted' }), { EX: 300 });
    fs.writeFileSync('/tmp/saas-fixtures/state.json', JSON.stringify({ fail: !!scenario.fail }));
    const before = calls().length;
    const response = await fetch(`http://127.0.0.1:3000/speech/${channel}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: scenario.provider, mode: scenario.provider === 'fish' ? 'clone' : 'speak',
        ...(scenario.provider === 'fish' ? { cloneName: 'gojo' } : scenario.provider === 'kokoro' ? { voice: 'am_michael' } : {}),
        text: '[happy] 0123456789abcdef', language: 'en' }),
    });
    assert.equal(response.status, 200, await response.text());
    const prefix = `42/speech/${channel},`;
    const [, payload] = JSON.parse((await wait(prefix + '["speech",')).slice(prefix.length));
    assert.equal(payload.mode, 'speak');
    assert.equal(payload.text, '0123456789abcdef');
    assert.equal(payload.mimeType, scenario.expected === 'kokoro' ? 'audio/mpeg' : 'audio/wav');
    // Fetch the actual served file from the isolated API, regardless of public URL settings.
    const served = await fetch('http://127.0.0.1:3000' + new URL(payload.audioUrl, 'http://127.0.0.1:3000').pathname);
    assert.equal(served.status, 200);
    assert.ok((await served.arrayBuffer()).byteLength > 44);
    const newCalls = calls().slice(before);
    const kokoro = newCalls.filter(call => call.kokoro);
    const piper = newCalls.filter(call => call.piper);
    assert.equal(kokoro.length, scenario.expected === 'kokoro' || scenario.fail ? 1 : 0);
    assert.equal(piper.length, scenario.expected === 'piper' ? 1 : 0);
    if (scenario.expected === 'kokoro') {
      assert.equal(kokoro[0].kokoro.voice, scenario.voice);
      assert.deepEqual(kokoro[0].kokoro.provider, { only: ['deepinfra'], order: ['deepinfra'], allow_fallbacks: false });
    }
    const balance = JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance;
    assert.equal(balance, (scenario.available ? 10000 : 0) - (scenario.expected === 'kokoro' ? 2 : 1),
      'bill only the provider that successfully produced audio');
    ws.send(`42/speech/${channel},${JSON.stringify(['speech-ended', { speechID: payload.speechID }])}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!await redis.exists(`twitch:${channel}:tts:processing`)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await redis.exists(`twitch:${channel}:tts:processing`), 0);
    console.log(`PASS ${scenario.plan}/${scenario.provider}/${scenario.fail ? 'outage' : scenario.available ? 'available' : 'exhausted'} -> ${scenario.expected}`);
  }
} finally { ws.close(); }

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
  '/app/dist/handlers/tts_credit_fallback.test.js', '/app/dist/handlers/tts_queue_credits.test.js',
  '/app/dist/server/services/tts/kokoro_tts.test.js', '/app/dist/utils/tts_usage.test.js'],
{ stdio: 'inherit', timeout: 60000, env: { ...process.env, NODE_OPTIONS: '' } });
console.log('PASS: paid exhausted Kokoro, free Piper, selected voices, provider failures, overlay playback and actual-provider billing');
process.exit(0);
