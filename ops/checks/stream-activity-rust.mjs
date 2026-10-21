// saas-ops candidate check: actual cron command, native projector, disposable DBs.
// Stage cron-boot.mjs, activity.mjs (dima-rust fixture), analytics-store.mjs
// (exact dima-analytics/src/store.mjs) under /tmp/saas-fixtures before startup.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire('/app/package.json');
const { MongoClient, ObjectId } = require('mongodb');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo', 'only disposable helper Mongo alias is permitted');
assert.equal(process.env.DRAGONFLY_HOST, 'redis', 'only disposable helper Redis alias is permitted');
const databaseName = decodeURIComponent(uri.pathname.slice(1));
assert.match(databaseName, /^stream_activity_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.STREAM_ACTIVITY_RUNTIME, 'rust');
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000 });
const redis = createClient({ url: `redis://redis:${process.env.DRAGONFLY_PORT || '6379'}`, socket: { reconnectStrategy: false } });
redis.on('error', () => {});
const owned = new Set([databaseName]), stopped = new Set(), auxiliary = new Set();
const collections = ['stream_activities', 'stream_activity_aggregates', 'stream_activity_states'];
const stateId = 'projector-v1';
const dashboard = { _id: 'dashboard-projector-v1', seq: 71, marker: 'fixture-only-untouched' };
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"), 'stage exact analytics store source');
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
const { streamActivityFixtures } = await import('/tmp/saas-fixtures/activity.mjs');
mongoose.set('autoIndex', false);
const schemas = await import('/app/dist/schemas/stream_activity.schema.js');
const { projectStreamActivityBatch } = await import('/app/dist/utils/stream_activity.js');

function fixtureDatabase(label) {
    const name = `stream_activity_fixture_ops_${process.pid}_${label}`;
    assert.match(name, /^stream_activity_fixture_[a-zA-Z0-9_]+$/);
    assert(Buffer.byteLength(name) <= 63);
    owned.add(name);
    return client.db(name);
}
async function waitFor(check, label, timeout = 25000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await check();
        if (value) return value;
        await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}
async function records(scope = 'main') {
    let text;
    try { text = await readFile('/tmp/saas-fixtures/spawns.jsonl', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), exits = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !exits.has(row.pid)).at(-1);
}
function normalize(value) {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value?._bsontype === 'ObjectId') return { $oid: value.toHexString() };
    if (['Long', 'Int32', 'Double', 'Decimal128'].includes(value?._bsontype)) return Number(value.toString());
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    return value;
}
async function snapshot(db) {
    const result = {};
    for (const name of collections) result[name] = (await db.collection(name).find().sort({ _id: 1 }).toArray()).map(row => {
        if (name === collections[1]) delete row.updatedAt;
        if (name === collections[2] && row._id === stateId) { delete row.owner; delete row.leaseUntil; delete row.updatedAt; }
        return normalize(row);
    });
    return result;
}
async function makeCollections(db) {
    for (const model of [schemas.StreamActivitySchema, schemas.StreamActivityAggregateSchema, schemas.StreamActivityStateSchema]) {
        for (const [key, options] of model.schema.indexes()) await db.collection(model.collection.name).createIndex(key, options);
    }
}
async function connectReference(db) {
    await mongoose.disconnect();
    await mongoose.connect(uri.href, { dbName: db.databaseName, serverSelectionTimeoutMS: 5000 });
}
async function gate(db) {
    await waitFor(async () => {
        const state = await db.collection(collections[2]).findOne({ _id: stateId });
        return state && state.leaseUntil <= new Date();
    }, 'projector idle lease');
    await db.collection(collections[2]).updateOne({ _id: stateId }, { $set: { owner: 'fixture-gate', leaseUntil: new Date(Date.now() + 600000) } });
}
async function release(db) {
    await db.collection(collections[2]).updateOne({ _id: stateId }, { $set: { leaseUntil: new Date(0) } });
}
async function complete(db, ids) {
    await waitFor(async () => await db.collection(collections[0]).countDocuments({ _id: { $in: ids }, processed: true }) === ids.length
        && !(await db.collection(collections[2]).findOne({ _id: stateId }))?.active, 'native checkpoint completion');
}
async function copyPartial(baseline, actual, seq, ids) {
    const rows = await baseline.collection(collections[1]).find().sort({ _id: 1 }).toArray();
    const selected = rows.filter((row, index) => row.scope === 'distinct' ? row.firstSeq === seq : row.lastSeq === seq && index % 2 === 0);
    for (const row of selected) await actual.collection(collections[1]).replaceOne({ _id: row._id }, row, { upsert: true });
    await actual.collection(collections[2]).updateOne({ _id: stateId }, { $set: { seq, active: { seq, ids } } });
    assert(selected.some(row => row.scope === 'distinct'), 'handoff must include distinct receipts');
    assert(selected.some(row => row.scope !== 'distinct'), 'handoff must include fenced aggregate writes');
}
async function nativeStatus(pid) {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(text, /^Name:\s+stream_activity$/m);
    assert.match(text, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m, 'actual native process must drop root');
    assert(Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1]) > 0, 'actual native process must have readable resident memory');
}
async function assertOneNative(root) {
    const rows = (await records()).filter(row => row.supervisor === root);
    const dead = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    const alive = rows.filter(row => row.event === 'spawn' && row.native && !dead.has(row.pid));
    assert.equal(alive.length, 1, 'one native stream-activity child per actual supervisor');
    await nativeStatus(alive[0].pid);
    // Inspect command lines, never protected setuid process environments/exe links.
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
        let command;
        try { command = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
        assert(!command.split('\0').some(arg => arg.endsWith('/stream_activity.worker.js')), 'legacy TypeScript projector must not be running');
    }
}
async function assertTelemetry(requireError = false) {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
    for (const batch of batches) validateBatch(batch);
    const rows = batches.flatMap(batch => batch.metrics.map(metric => ({ ...metric, service: batch.service })))
        .filter(row => row.name.startsWith('stream_activity_rust.'));
    const names = new Set(['stream_activity_rust.rss_bytes', 'stream_activity_rust.cpu_cores', 'stream_activity_rust.batch_events', 'stream_activity_rust.project_batch', 'stream_activity_rust.errors', 'stream_activity_rust.restarts']);
    for (const row of rows) {
        assert(names.has(row.name), 'native metadata must not contain Node heap/event-loop or arbitrary labels');
        assert.equal(row.service, 'cron'); assert.equal(row.channel, '');
        assert(Number.isFinite(row.sum) && row.sum >= 0);
    }
    const has = (name, predicate = () => true) => rows.some(row => row.name === name && predicate(row));
    return has('stream_activity_rust.rss_bytes', row => row.kind === 'runtime' && row.max > 0)
        && has('stream_activity_rust.cpu_cores', row => row.kind === 'runtime')
        && has('stream_activity_rust.batch_events', row => row.kind === 'worker' && row.sum >= 1)
        && has('stream_activity_rust.project_batch', row => row.kind === 'queue_run' && row.outcome === 'ok')
        && (!requireError || has('stream_activity_rust.project_batch', row => row.outcome === 'error'));
}

try {
    await client.connect(); await redis.connect();
    const actual = client.db(databaseName), baseline = fixtureDatabase('baseline');
    const native = await waitFor(() => currentNative(), 'actual supervised Rust startup');
    const root = native.supervisor;
    assert.equal(native.command, '/usr/local/bin/stream_activity');
    assert.equal(native.uid, 65534); assert.equal(native.gid, 65534);
    await assertOneNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    assert(unrelated.length > 0, 'actual supervisor must have unrelated mocked workers');
    await makeCollections(actual); await makeCollections(baseline);
    await gate(actual);
    for (const db of [actual, baseline]) await db.collection(collections[2]).insertOne(dashboard);
    const rows = streamActivityFixtures(ObjectId).filter(row => row.expiresAt > new Date()).map(row => new schemas.StreamActivitySchema(row).toObject());
    const ids = rows.filter(row => !row.processed).map(row => row._id);
    await baseline.collection(collections[0]).insertMany(rows);
    await connectReference(baseline);
    assert.equal(await projectStreamActivityBatch(500), ids.length);
    await actual.collection(collections[0]).insertMany(rows);
    await copyPartial(baseline, actual, 1, ids);
    await release(actual); await complete(actual, ids);
    assert.deepEqual(await snapshot(actual), await snapshot(baseline));
    console.log('PASS actual supervised Rust completes TypeScript-produced partial checkpoint with exact persisted parity');

    const extra = stage => Array.from({ length: 4 }, (_, index) => new schemas.StreamActivitySchema({ ...rows[0],
        _id: `fixture-stage-${stage}-${index}`, occurredAt: new Date(Date.parse('2100-01-01') + stage * 600000 + index),
        offset: stage * 600, channelID: stage === 3 ? 'fixture-error-channel' : rows[0].channelID,
        actor: `fixture-stage-${stage}`, actorLabel: `Fixture stage ${stage}`, processed: false }).toObject());
    await gate(actual);
    const second = extra(2), secondIds = second.map(row => row._id);
    await baseline.collection(collections[0]).insertMany(second);
    assert.equal(await projectStreamActivityBatch(500), second.length);
    await actual.collection(collections[0]).insertMany(second);
    await copyPartial(baseline, actual, 2, secondIds);
    const killed = await currentNative();
    process.kill(killed.pid, 'SIGKILL');
    await release(actual);
    const replacement = await waitFor(async () => {
        const child = await currentNative(); return child && child.pid !== killed.pid ? child : null;
    }, 'only failed native child restarts');
    await complete(actual, secondIds);
    assert.deepEqual(await snapshot(actual), await snapshot(baseline));
    await assertOneNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    assert((await records()).some(row => row.event === 'exit' && row.pid === killed.pid && row.signal === 'SIGKILL'));
    console.log('PASS killing actual Rust PID restarts only stream activity and resumes its fenced checkpoint');
    await waitFor(() => assertTelemetry(), 'native live RSS/CPU and batch metrics in analytics-valid Redis envelopes', 35000);
    console.log('PASS native RSS/CPU and bounded batch metrics reach existing Redis telemetry inbox and pass analytics validator');

    await gate(actual);
    const third = extra(3), thirdIds = third.map(row => row._id);
    await baseline.collection(collections[0]).insertMany(third);
    assert.equal(await projectStreamActivityBatch(500), third.length);
    await actual.command({ collMod: collections[1], validator: { scope: { $ne: 'summary' } }, validationLevel: 'strict', validationAction: 'error' });
    await actual.collection(collections[0]).insertMany(third);
    const failing = await currentNative();
    await release(actual);
    await waitFor(async () => (await records()).some(row => row.event === 'exit' && row.pid === failing.pid && row.code === 1), 'actual Rust reports nonduplicate validator failure');
    await actual.collection(collections[2]).updateOne({ _id: stateId }, { $set: { owner: 'fixture-gate', leaseUntil: new Date(Date.now() + 600000) } });
    const failedState = await actual.collection(collections[2]).findOne({ _id: stateId });
    assert.equal(failedState.seq, 3); assert.deepEqual(failedState.active.ids, thirdIds);
    assert.equal(await actual.collection(collections[0]).countDocuments({ _id: { $in: thirdIds }, processed: true }), 0);
    assert(await actual.collection(collections[1]).countDocuments({ lastSeq: 3 }) > 0, 'real failure must leave partial unordered writes');
    const paused = await waitFor(async () => {
        const child = await currentNative(); return child && child.pid !== failing.pid ? child : null;
    }, 'failed batch replacement');
    process.kill(paused.pid, 'SIGSTOP'); stopped.add(paused.pid);
    await actual.command({ collMod: collections[1], validator: {}, validationLevel: 'strict' });
    await release(actual); await connectReference(actual);
    assert.equal(await projectStreamActivityBatch(500), third.length);
    assert.deepEqual(await snapshot(actual), await snapshot(baseline));
    process.kill(paused.pid, 'SIGCONT'); stopped.delete(paused.pid);
    await waitFor(() => assertTelemetry(true), 'failed native batch telemetry', 25000);
    await assertOneNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    console.log('PASS real Rust partial failure hands checkpoint back to TypeScript without duplication; error metadata is observable');

    const shutdown = fixtureDatabase('shutdown');
    const shutdownUri = new URL(uri.href); shutdownUri.pathname = `/${shutdown.databaseName}`;
    const child = spawn(process.execPath, ['/app/dist/workers/cron.index.js'], { cwd: '/app',
        env: { ...process.env, MONGO_URI: shutdownUri.href, STREAM_ACTIVITY_FIXTURE_SCOPE: 'shutdown' }, stdio: ['ignore', 'pipe', 'pipe'] });
    auxiliary.add(child);
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    completion.catch(() => {}); child.fixtureCompletion = completion;
    const ownedChild = await waitFor(() => currentNative('shutdown'), 'auxiliary actual supervisor native child');
    await waitFor(async () => {
        const state = await shutdown.collection(collections[2]).findOne({ _id: stateId }); return state?.owner && state.leaseUntil <= new Date();
    }, 'auxiliary native idle');
    child.kill('SIGTERM');
    let shutdownTimer;
    const exit = await Promise.race([completion, new Promise((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error('Auxiliary supervisor shutdown timed out')), 15000);
    })]).finally(() => clearTimeout(shutdownTimer));
    auxiliary.delete(child);
    assert.equal(exit.code, 0, output.slice(-2000)); assert.equal(exit.signal, null);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === ownedChild.pid && row.code === 0 && row.signal === null), 'native graceful supervised shutdown');
    assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1, 'shutdown must not restart native child');
    console.log('PASS actual auxiliary supervisor SIGTERM gracefully stops native child without restart; main candidate remains running');
} finally {
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of auxiliary) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...auxiliary].map(child => child.fixtureCompletion));
    await mongoose.disconnect();
    try {
        for (const name of owned) { assert.match(name, /^stream_activity_fixture_[a-zA-Z0-9_]+$/); await client.db(name).dropDatabase(); }
    } finally {
        await client.close();
        if (redis.isOpen) redis.destroy();
    }
}
