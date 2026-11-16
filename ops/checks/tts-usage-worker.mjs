// Behavior check for the cron `tts-usage` worker: OpenRouter voice lines wait in MongoDB until
// OpenRouter reports what it charged, then go to Polar as one `ai_usage` event with the real cost.
//
//   scripts/saas-ops verify cron-<run-id> --dependency mongo --dependency redis \
//     --test-env ops/checks/tts-usage-worker-fixtures/test-env.json \
//     --fixtures ops/checks/tts-usage-worker-fixtures --check ops/checks/tts-usage-worker.mjs
//
// The real supervisor runs only tts-usage and ai-usage-receipts against disposable databases.
// OpenRouter's generation lookup and Polar are mocked in the preload; nothing leaves the candidate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const app = '/app';
const load = file => import(`${app}/dist/${file}`);
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(decodeURIComponent(uri.pathname.slice(1)), 'cron_ts_workers_fixture_tts_usage', 'disposable fixture database only');
assert(uri.hostname === 'mongo' && process.env.DRAGONFLY_HOST === 'redis', 'disposable dependencies only');

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', `${app}/dist/utils/tts/tts_provider_cost.test.js`, `${app}/dist/utils/polarsh_accounting.test.js`,
    `${app}/dist/utils/tts_usage.test.js`], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });

let passed = 0;
const group = async (name, run) => { const at = Date.now(); await run(); console.log(`ok ${++passed} - ${name} (${Date.now() - at} ms)`); };
async function until(check, label, timeout = 40000, interval = 100) {
    const end = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
        await sleep(interval);
    }
}
const workerPids = file => readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).filter(entry => {
    try { return readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(`/${file}.worker.js`); } catch { return false; }
});
const logPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// Only events Polar accepted (the mock answers 503 while `polarDown`).
const polarEvent = entryId => calls().filter(call => call.status === 200).flatMap(call => call.body?.events || [])
    .find(event => event.external_id === entryId || event.externalId === entryId);
const state = value => fs.writeFileSync('/tmp/saas-fixtures/state.json', JSON.stringify(value));
state({});

const { getMongoDBConnection } = await load('utils/databases/mongodb.database.js');
const { getDragonflyClient } = await load('utils/databases/dragonfly.database.js');
const mongo = await getMongoDBConnection('tts-usage-check');
const redis = await getDragonflyClient('tts-usage-check');
const db = mongo.connection.db;
const pending = db.collection('tts_usage_pending');
const receipts = db.collection('ai_usage_receipts');
const channel = '900000777', customerId = 'customer-tts-usage';
const credits = async () => JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance;
await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 10000, balance: 10000, available: true, status: 'available' }), { EX: 600 });
const row = (id, extra = {}) => ({
    entryId: `entry-${id}`, channelID: channel, customerId, provider: 'fish', backend: 'fish-audio/drama-3', generationId: `gen-pending-${id}`,
    bytes: 41, characters: 32, credits: 48, usage: { requestId: `request-${id}`, source: 'chat', provider: 'fish', quantity: 32, unit: 'characters',
        resourceType: 'speech', resourceId: `speech-${id}`, receipt: { model: 'fish-audio/drama-3' } },
    occurredAt: new Date(), nextAttemptAt: new Date(), attempts: 0, lastError: null, ...extra
});

await group('tts-usage is registered without an off switch and runs under the real supervisor', async () => {
    const { WORKERS } = await load('workers/cron.index.js');
    const worker = WORKERS.find(entry => entry.name === 'tts-usage');
    assert.equal(worker?.distEntry, 'dist/workers/tts_usage.worker.js');
    assert.equal(worker.enabledEnv, undefined, 'billing must not be switchable off');
    await until(() => workerPids('tts_usage').length === 1 && workerPids('ai_usage_receipts').length === 1, 'tts-usage and receipts workers running');
});

await group('a parked line is sent with OpenRouter\'s real charge, fixed credits, one local debit and a receipt', async () => {
    const { trackTtsUsage } = await load('utils/tts_usage.js');
    const text = '¡Olé ñandú! 😀 ¿Qué tal, mañana?';
    // The generation id tells the mock to report $0.00008: a promotion, well under the $10/M list price.
    const usage = await trackTtsUsage({ channelID: channel, streamer: { polar_sh_customer_id: customerId, plan_tier: 'pro' }, provider: 'fish',
        characters: text.length, text, requireDurableUsage: true,
        providerCost: { backend: 'fish-audio/drama-3', bytes: Buffer.byteLength(text, 'utf8'), generationId: 'gen-found-0.00008' },
        usage: { entryId: 'entry-real', requestId: 'request-real', source: 'chat', resourceType: 'speech', resourceId: 'speech-real', receipt: { voice: 'gojo' } } });
    assert.equal(usage.creditsConsumed, 48);
    assert.equal(await credits(), 10000 - 48, 'credits taken at once');
    const parked = await pending.findOne({ entryId: 'entry-real' });
    assert.ok(parked, 'parked in MongoDB');
    assert.equal(parked.nextAttemptAt - parked.occurredAt, 30000);
    assert.equal(polarEvent('entry-real'), undefined, 'nothing sent before the cost is known');
    await pending.updateOne({ entryId: 'entry-real' }, { $set: { nextAttemptAt: new Date() } });
    await until(async () => !(await pending.findOne({ entryId: 'entry-real' })), 'parked line sent and removed');
    const event = polarEvent('entry-real');
    assert.equal(event.name, 'ai_usage');
    assert.equal(event.customer_id ?? event.customerId, customerId);
    assert.deepEqual(event.metadata._cost, { amount: 0.008, currency: 'usd' }, '_cost is the real charge in cents');
    assert.equal(event.metadata.cost, 0.00008, 'cost is the same charge in USD, as OpenRouter reports it');
    assert.equal(event.metadata.credits, 48, 'credits stay the fixed price despite the promotion');
    assert.equal(event.metadata.reason, 'tts_fish');
    assert.equal(event.metadata.characters, 32);
    assert.equal(event.metadata.usage_source, 'chat');
    assert.equal(event.metadata.entry_id, 'entry-real');
    assert.equal(calls().find(call => call.generation === 'gen-found-0.00008')?.auth, 'Bearer dummy');
    assert.equal(await credits(), 10000 - 48, 'sending does not take the credits a second time');
    const receipt = await until(() => receipts.findOne({ channelID: channel, entryId: 'entry-real' }), 'receipt written');
    assert.equal(receipt.costUsd, 0.00008);
    assert.equal(receipt.credits, 48);
    assert.equal(receipt.model, 'fish-audio/drama-3');
    assert.equal(receipt.voice, 'gojo');
});

await group('a line OpenRouter has not recorded yet waits; a failed lookup records why', async () => {
    await pending.insertMany([row('young'), row('error', { generationId: 'gen-error-1' })]);
    // Claimed rows carry a 2-minute lease; a rescheduled one is due again in about 20 s.
    const young = await until(async () => { const doc = await pending.findOne({ entryId: 'entry-young' });
        const wait = doc ? doc.nextAttemptAt - Date.now() : 0; return doc?.attempts >= 1 && wait > 10000 && wait <= 20000 && doc; }, 'young line rescheduled');
    assert.equal(young.lastError, null);
    const failed = await until(async () => { const doc = await pending.findOne({ entryId: 'entry-error' }); return doc?.lastError && doc; }, 'failed lookup rescheduled');
    assert.match(failed.lastError, /HTTP 502/);
    assert.equal(polarEvent('entry-young'), undefined);
    assert.equal(polarEvent('entry-error'), undefined);
    await pending.deleteMany({ entryId: { $in: ['entry-young', 'entry-error'] } });
});

await group('after 15 minutes without an answer the list price is used', async () => {
    await pending.insertOne(row('old', { occurredAt: new Date(Date.now() - 16 * 60_000) }));
    await until(async () => !(await pending.findOne({ entryId: 'entry-old' })), 'old line sent');
    const event = polarEvent('entry-old');
    // 41 bytes of Drama 3 at $10 per million = $0.00041 = 0.041 cents.
    assert.deepEqual(event.metadata._cost, { amount: 0.041, currency: 'usd' });
    assert.equal(event.metadata.cost, 0.00041);
    assert.equal(event.metadata.credits, 48);
});

await group('during a Polar outage the line stays until the worker itself has flushed it to Polar', async () => {
    state({ polarDown: true });
    await pending.insertOne(row('outage', { generationId: 'gen-found-0.0002' }));
    const waiting = await until(async () => { const doc = await pending.findOne({ entryId: 'entry-outage' }); return doc?.queued && doc; }, 'line marked queued');
    assert.match(waiting.lastError || '', /./, 'the failure is recorded');
    const queued = (await redis.lRange(`twitch:${channel}:ai:polarshevent`, 0, -1)).map(JSON.parse);
    assert.equal(queued.filter(event => event.externalId === 'entry-outage').length, 1, 'kept once in the durable queue');
    assert.equal(queued.find(event => event.externalId === 'entry-outage').metadata._cost.amount, 0.02, 'the real cost is fixed in the queued event');
    assert.equal(polarEvent('entry-outage'), undefined);
    const lookups = calls().filter(call => call.generation === 'gen-found-0.0002').length;
    // Polar is back. No other line arrives for this channel: the worker must flush on its own.
    state({});
    await pending.updateOne({ entryId: 'entry-outage' }, { $set: { nextAttemptAt: new Date() } });
    await until(async () => !(await pending.findOne({ entryId: 'entry-outage' })), 'queued line flushed and removed');
    assert.ok(polarEvent('entry-outage'), 'Polar accepted the event');
    assert.equal(await redis.lLen(`twitch:${channel}:ai:polarshevent`), 0);
    assert.equal(calls().filter(call => call.generation === 'gen-found-0.0002').length, lookups, 'no second lookup or send');
});

await group('the worker is still the same healthy process', async () => {
    assert.equal(workerPids('tts_usage').length, 1);
    assert.equal(await pending.countDocuments({ channelID: channel }), 0);
});

await mongo.disconnect?.();
console.log(`PASS tts-usage worker: ${passed} groups`);
process.exit(0);
