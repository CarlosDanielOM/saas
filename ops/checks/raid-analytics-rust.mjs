// saas-ops check of the real cron command and supervised raid_analytics binary.
// --fixtures must contain this check's cron-boot.mjs and the exact source
// dima-analytics/src/store.mjs renamed analytics-store.mjs. No live env is used.
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
assert.equal(uri.hostname, 'mongo'); assert.equal(process.env.DRAGONFLY_HOST, 'redis');
const databaseName = decodeURIComponent(uri.pathname.slice(1));
assert.match(databaseName, /^raid_analytics_fixture_[a-zA-Z0-9_]+$/);
assert([undefined, 'node'].includes(process.env.CRON_WORKER_RUNTIME), 'exercise production node runtime');
assert.equal(process.env.RAID_ANALYTICS_RUNTIME, undefined, 'exercise native default selection');
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const redis = createClient({ url: `redis://redis:${process.env.DRAGONFLY_PORT || '6379'}`, socket: { reconnectStrategy: false } });
redis.on('error', () => {});
const owned = new Set([databaseName]), stopped = new Set(), auxiliary = new Set();
const deadline = Date.now() + 250000;
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"), 'stage exact analytics store source');
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
mongoose.set('autoIndex', false);
const { RaidAnalyticsHistorySchema: History, RaidAnalyticsSummarySchema: Summary } = await import('/app/dist/schemas/raid_analytics.schema.js');
const { DomainEventSchema: Events } = await import('/app/dist/schemas/domain_event.schema.js');
const { projectRaidSummaryOnce } = await import('/app/dist/utils/raid_analytics.js');
const names = { history: History.collection.name, summary: Summary.collection.name, events: Events.collection.name };
const actual = client.db(databaseName);
function fixtureDatabase(label) {
    const name = `raid_analytics_fixture_${process.pid}_${label}`;
    assert.match(name, /^raid_analytics_fixture_[a-zA-Z0-9_]+$/); assert(Buffer.byteLength(name) <= 63);
    owned.add(name); return client.db(name);
}
const baseline = fixtureDatabase('baseline');
async function waitFor(check, label, timeout = 15000) {
    const until = Math.min(deadline, Date.now() + timeout);
    do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < until);
    throw new Error(`Timed out: ${label}`);
}
async function records(scope = 'main') {
    let text;
    try { text = await readFile('/tmp/saas-fixtures/raid-spawns.jsonl', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), dead = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !dead.has(row.pid)).at(-1);
}
async function pause() {
    const row = await waitFor(() => currentNative(), 'native process available to pause');
    process.kill(row.pid, 'SIGSTOP'); stopped.add(row.pid);
    await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`, 'utf8')), 'native stopped for fixture staging');
    return row;
}
function resume(row) { process.kill(row.pid, 'SIGCONT'); stopped.delete(row.pid); }
function normalize(value) {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value?._bsontype === 'ObjectId') return { $oid: value.toHexString() };
    if (['Long', 'Int32', 'Double', 'Decimal128'].includes(value?._bsontype)) return Number(value.toString());
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    return value;
}
function comparablePayload(payload) {
    const result = normalize(payload);
    // MongoDB $group makes no ordering guarantee. Dashboard consumers select
    // totals by direction; recent/top arrays have explicit order and stay exact.
    for (const days of ['7', '30']) if (Array.isArray(result[days]?.totals))
        result[days].totals.sort((left, right) => String(left._id).localeCompare(String(right._id)));
    return result;
}
async function indexes(db) {
    for (const model of [History, Summary, Events]) for (const [keys, options] of model.schema.indexes())
        await db.collection(model.collection.name).createIndex(keys, options);
}
const DAY = 86400000, fixtureNow = Date.now(), expiry = new Date(fixtureNow + 90 * DAY);
const channel = 'fixture-parity-channel';
function history(id, direction, peerID, at, extra = {}) {
    return new History({ _id: id, channelID: channel, direction, peerID,
        peerLogin: `${peerID}_login`, peerName: `${peerID} name`, viewers: 10,
        occurredAt: new Date(at), expiresAt: expiry, ...extra }).toObject();
}
let eventSequence = 0;
function follow(at, extra = {}) {
    const id = ++eventSequence;
    return new Events({ _id: new ObjectId(), eventKey: `raid-fixture-${id}`, sourceEventId: `raid-fixture-${id}`,
        source: 'twitch-eventsub', type: 'channel.follow.received', topic: 'channel', channelID: channel,
        occurredAt: new Date(at), journaledAt: new Date(fixtureNow), payload: {}, expiresAt: expiry, ...extra }).toObject();
}
function fixtures() {
    const at = fixtureNow - 3600000;
    const rows = [
        history('tie-a', 'incoming', 'peer-a', at), history('tie-b', 'incoming', 'peer-b', at),
        history('overlap', 'incoming', 'peer-a', at + 120000),
        history('closed', 'incoming', 'peer-c', at + 600000),
        history('open', 'incoming', 'peer-d', fixtureNow - 30000),
        history('stale', 'incoming', 'peer-e', fixtureNow - 2 * DAY,
            { followsAfter: 99, followsComputedAt: new Date(fixtureNow - 16 * 60000), followWindowEnd: new Date(fixtureNow - 2 * DAY + 300000) }),
        history('null-fields', 'outgoing', 'peer-null', fixtureNow - 3 * DAY,
            { peerName: null, peerLogin: null, viewers: null, followsAfter: null }),
        history('missing-fields', 'outgoing', 'peer-missing', fixtureNow - 4 * DAY,
            { peerName: undefined, peerLogin: undefined, viewers: undefined }),
        history('older-30', 'incoming', 'peer-30', fixtureNow - 20 * DAY),
        history('reciprocity-old', 'outgoing', 'peer-a', fixtureNow - 40 * DAY),
        history('expired', 'incoming', 'peer-expired', fixtureNow - 1000, { expiresAt: new Date(fixtureNow - DAY) }),
        history('future', 'incoming', 'peer-future', fixtureNow + DAY),
        history('future-outgoing', 'outgoing', 'peer-a', fixtureNow + DAY),
        history('expired-outgoing', 'outgoing', 'peer-b', fixtureNow - 500, { expiresAt: new Date(fixtureNow - DAY) }),
    ];
    // Recent lists and top lists must actually truncate, including tied counts.
    for (let i = 0; i < 8; i++) {
        rows.push(history(`rank-in-${i}`, 'incoming', `rank-${i}`, fixtureNow - (5 + i) * 3600000, { viewers: i }));
        rows.push(history(`rank-out-${i}`, 'outgoing', `rank-${i}`, fixtureNow - (5 + i) * 3600000, { viewers: i }));
    }
    const events = [follow(at), follow(at + 1), follow(at + 119999), follow(at + 120000),
        follow(at + 419999), follow(at + 420000), follow(at + 600000), follow(at + 899999), follow(at + 900000),
        follow(fixtureNow - 20000), follow(fixtureNow + DAY),
        follow(at + 10, { source: 'other-provider' }), follow(at + 20, { type: 'channel.raid.received' }),
        follow(at + 30, { channelID: 'fixture-other-channel' }), follow(at + 40, { expiresAt: new Date(fixtureNow - DAY) })];
    return { rows, events };
}
async function queue(db, id, extra = {}) {
    await db.collection(names.summary).updateOne({ _id: id }, { $set: {
        dirtyAt: new Date(0), nextRefreshAt: new Date(0), leaseUntil: new Date(0), ...extra
    } }, { upsert: true });
}
async function refreshed(id, after = 0) {
    return waitFor(async () => {
        const state = await actual.collection(names.summary).findOne({ _id: id });
        return state?.payload && +state.updatedAt > after && +state.leaseUntil === 0 && state.error === false ? state : null;
    }, `native summary ${id}`);
}
async function compare(state) {
    const at = +state.payload['7'].to;
    assert.equal(+state.payload['30'].to, at);
    await mongoose.disconnect();
    await mongoose.connect(uri.href, { dbName: baseline.databaseName, serverSelectionTimeoutMS: 5000 });
    await baseline.collection(names.summary).updateMany({ _id: { $ne: state._id } },
        { $set: { nextRefreshAt: new Date(at + DAY) } });
    await queue(baseline, state._id);
    const RealDate = globalThis.Date;
    // Only the unchanged TypeScript reference sees the native batch's timestamp.
    // Return genuine Date instances: Mongoose Mixed cloning dispatches on the
    // instance constructor's name and reduces anonymous subclasses to numbers.
    function FrozenDate(...args) {
        return new.target ? Reflect.construct(RealDate, args.length ? args : [at]) : new RealDate(at).toString();
    }
    FrozenDate.prototype = RealDate.prototype;
    Object.setPrototypeOf(FrozenDate, RealDate);
    FrozenDate.now = () => at;
    globalThis.Date = FrozenDate;
    try { assert.equal(await projectRaidSummaryOnce(), true); }
    finally { globalThis.Date = RealDate; }
    const expected = await baseline.collection(names.summary).findOne({ _id: state._id });
    assert.deepEqual(comparablePayload(state.payload), comparablePayload(expected.payload), 'complete persisted payload must match unchanged TypeScript');
    assert.equal(+state.updatedAt, at); assert.equal(+state.nextRefreshAt, at + 60000);
    const query = { channelID: state._id, expiresAt: { $gt: new Date(at) } };
    const actualRows = await actual.collection(names.history).find(query).sort({ _id: 1 }).toArray();
    const expectedRows = await baseline.collection(names.history).find(query).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(actualRows), normalize(expectedRows), 'follow counts, open/closed windows and defaults persist identically');
    return expected;
}
async function assertNative(root) {
    const rows = (await records()).filter(row => row.supervisor === root);
    const dead = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    const alive = rows.filter(row => row.event === 'spawn' && row.native && !dead.has(row.pid));
    assert.equal(alive.length, 1);
    assert.equal(alive[0].command, '/usr/local/bin/raid_analytics');
    assert.equal(alive[0].uid, 65534); assert.equal(alive[0].gid, 65534);
    const status = await readFile(`/proc/${alive[0].pid}/status`, 'utf8');
    assert.match(status, /^Name:\s+raid_analytics$/m);
    assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
    assert(Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) > 0);
    // No environment/exe reads or protected /proc access workarounds.
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
        let command; try { command = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
        assert(!command.split('\0').some(arg => arg.endsWith('/raid_analytics.worker.js')), 'legacy raid process must not run');
    }
    for (const row of rows.filter(row => row.event === 'batch')) {
        const value = row.frame;
        assert.equal(value.event, 'batch'); assert([0, 1].includes(value.events));
        assert(Number.isFinite(value.durationMs) && value.durationMs >= 0); assert.equal(typeof value.success, 'boolean');
    }
}
async function telemetry() {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
    for (const batch of batches) validateBatch(batch);
    const rows = batches.flatMap(batch => batch.metrics.map(metric => ({ ...metric, service: batch.service })))
        .filter(row => row.name.startsWith('raid_analytics_rust.'));
    const allowed = new Set(['rss_bytes', 'cpu_cores', 'batch_channels', 'project_batch', 'errors', 'restarts']);
    for (const row of rows) {
        assert(allowed.has(row.name.slice('raid_analytics_rust.'.length)), 'native metrics must not impersonate Node heap/event-loop');
        assert.equal(row.service, 'cron'); assert.equal(row.channel, ''); assert(Number.isFinite(row.sum) && row.sum >= 0);
    }
    const has = (name, predicate) => rows.some(row => row.name === `raid_analytics_rust.${name}` && predicate(row));
    return has('rss_bytes', row => row.kind === 'runtime' && row.max > 0)
        && has('cpu_cores', row => row.kind === 'runtime')
        && has('batch_channels', row => row.kind === 'worker' && row.sum > 0)
        && has('project_batch', row => row.kind === 'queue_run' && row.outcome === 'ok')
        && has('project_batch', row => row.kind === 'queue_run' && row.outcome === 'error')
        && has('errors', row => row.sum > 0) && has('restarts', row => row.sum > 0);
}

try {
    await client.connect(); await redis.connect();
    const native = await waitFor(() => currentNative(), 'actual supervisor starts native raid worker');
    const root = native.supervisor;
    await assertNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    assert(unrelated.includes('stream-activity'), 'other native worker must be inert');
    assert((await records()).some(row => row.event === 'spawn' && row.worker === 'stream-activity'
        && row.requestedCommand === '/usr/local/bin/stream_activity'), 'node defaults must select both native projectors');
    assert(unrelated.includes('domain-events'), 'event-producing workers must be inert');
    const idle = await waitFor(async () => {
        const rows = (await records()).filter(row => row.event === 'batch' && row.frame.success && row.frame.events === 0);
        return rows.length >= 3 ? rows.slice(0, 3) : null;
    }, 'natural idle backoff', 12000);
    const gaps = [idle[1].at - idle[0].at, idle[2].at - idle[1].at];
    assert(gaps[0] >= 700 && gaps[1] >= gaps[0] * 1.3, 'idle polling should back off rather than hot-loop');
    console.log('PASS natural idle polling increases its delay without a busy loop');
    let paused = await pause();
    await indexes(actual); await indexes(baseline);
    const { rows, events } = fixtures();
    const sourceSnapshot = normalize(events.filter(row => row.expiresAt > new Date()).sort((a, b) => String(a._id).localeCompare(String(b._id))));
    for (const db of [actual, baseline]) {
        await db.collection(names.history).insertMany(rows); await db.collection(names.events).insertMany(events);
        await queue(db, channel);
    }
    resume(paused);
    let state = await refreshed(channel); paused = await pause(); await compare(state);
    const firstPayload = comparablePayload(state.payload);
    assert.equal(state.payload['7'].incoming.length, 5); assert.equal(state.payload['7'].topIncoming.length, 5);
    assert(!state.payload['7'].incoming.some(row => ['peer-expired', 'peer-future'].includes(row.peerID)));
    assert.equal(+state.payload['7'].topIncoming.find(row => row._id === 'peer-a').lastOutgoingAt, fixtureNow - 40 * DAY);
    console.log('PASS exact TypeScript parity for 7/30-day totals, top/recent, reciprocity, ties, expired/future rows and null/default fields');

    // Repeat without new source: deterministic fields stay identical; open windows
    // are deliberately recomputed at the next native timestamp.
    await queue(actual, channel); resume(paused);
    const previous = +state.updatedAt; state = await refreshed(channel, previous); paused = await pause(); await compare(state);
    assert.deepEqual(comparablePayload(state.payload)['7'].totals, firstPayload['7'].totals);
    const late = follow(fixtureNow - 3600000 + 650000);
    for (const db of [actual, baseline]) {
        await db.collection(names.events).insertOne(late);
        await db.collection(names.history).updateOne({ _id: 'closed' }, { $set: { followsComputedAt: new Date(0) } });
    }
    await queue(actual, channel); resume(paused);
    state = await refreshed(channel, +state.updatedAt); paused = await pause(); await compare(state);
    assert.equal((await actual.collection(names.history).findOne({ _id: 'closed' })).followsAfter, 3);
    const sourceAfter = await actual.collection(names.events).find({ expiresAt: { $gt: new Date() }, _id: { $ne: late._id } }).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(sourceAfter), sourceSnapshot, 'native projector never mutates or creates source domain events');
    console.log('PASS repeat projection is idempotent and late retained follow events repair previously computed windows');

    const held = 'fixture-held';
    await queue(actual, held, { owner: 'other-owner', leaseUntil: new Date(Date.now() + 600000) });
    const before = (await records()).filter(row => row.event === 'batch').length;
    resume(paused);
    await waitFor(async () => (await records()).filter(row => row.event === 'batch').length > before, 'worker observes owner-held queue');
    assert.equal((await actual.collection(names.summary).findOne({ _id: held })).payload, undefined);
    paused = await pause();
    await actual.collection(names.summary).updateOne({ _id: held }, { $set: { leaseUntil: new Date(Date.now() - 1) } });
    resume(paused); await refreshed(held); paused = await pause();
    console.log('PASS unexpired owner lease prevents projection and expired lease is recovered');

    // A queued backlog must drain without the legacy mandatory second per pass.
    const backlog = Array.from({ length: 16 }, (_, i) => `fixture-backlog-${i}`);
    for (const id of backlog) await queue(actual, id);
    const drainStart = Date.now(); resume(paused);
    await waitFor(async () => await actual.collection(names.summary).countDocuments({ _id: { $in: backlog }, error: false,
        payload: { $exists: true }, leaseUntil: new Date(0) }) === backlog.length, 'immediate backlog drain', 11000);
    const drainMs = Date.now() - drainStart;
    assert(drainMs < 11000, '16 channels must avoid legacy 15 mandatory seconds of delay');
    paused = await pause();
    console.log(`PASS 16 due channels drained in ${drainMs} ms without per-channel sleep (11-second bound)`);

    // Exercise the changed unordered history bulk path itself: one rejected
    // update must leave successful siblings, but never a published summary.
    const partialChannel = 'fixture-partial-history';
    const partialRaids = Array.from({ length: 4 }, (_, i) => history(`partial-history-${i}`, 'incoming', `partial-peer-${i}`,
        fixtureNow - 2 * 3600000 + i * 600000, { channelID: partialChannel }));
    const partialEvents = partialRaids.map(row => follow(+row.occurredAt + 60000, { channelID: partialChannel }));
    for (const db of [actual, baseline]) {
        await db.collection(names.history).insertMany(partialRaids);
        await db.collection(names.events).insertMany(partialEvents);
        await queue(db, partialChannel);
    }
    const rejectedId = partialRaids[1]._id;
    await actual.command({ collMod: names.history,
        validator: { $or: [{ _id: { $ne: rejectedId } }, { followsAfter: null }] },
        validationLevel: 'strict', validationAction: 'error' });
    const partialFailurePid = paused.pid; resume(paused);
    await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: partialChannel });
        return row?.error === true && +row.leaseUntil === 0 && +row.nextRefreshAt > Date.now();
    }, 'history bulk failure releases lease and schedules retry');
    assert.equal((await actual.collection(names.summary).findOne({ _id: partialChannel })).payload, undefined);
    await waitFor(async () => (await records()).some(row => row.event === 'batch'
        && row.pid === partialFailurePid && row.frame.success === false), 'history bulk failed batch protocol');
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== partialFailurePid; }, 'history bulk failure replacement');
    paused = await pause();
    const partialRows = await actual.collection(names.history).find({ channelID: partialChannel }).sort({ _id: 1 }).toArray();
    const persisted = partialRows.filter(row => row.followsAfter === 1 && row.followsComputedAt instanceof Date
        && +row.followsComputedAt > 0 && row.followWindowEnd instanceof Date);
    assert(persisted.length > 0 && persisted.length < partialRaids.length,
        'real unordered MongoDB bulk must persist successful siblings despite one validation failure');
    assert.equal(partialRows.find(row => row._id === rejectedId).followsAfter, null);
    // The unchanged TS reference resumes the exact same persisted partial state;
    // completed windows retain their original timestamp instead of recomputing.
    for (const row of partialRows) await baseline.collection(names.history).replaceOne({ _id: row._id }, row);
    await actual.command({ collMod: names.history, validator: {}, validationLevel: 'strict' });
    await queue(actual, partialChannel); resume(paused);
    const recoveredPartial = await refreshed(partialChannel); paused = await pause(); await compare(recoveredPartial);
    const repairedRows = await actual.collection(names.history).find({ channelID: partialChannel }).sort({ _id: 1 }).toArray();
    assert(repairedRows.every(row => row.followsAfter === 1), 'retry recomputes missing counts without doubling siblings');
    for (const row of persisted) assert.deepEqual(normalize(repairedRows.find(repaired => repaired._id === row._id)), normalize(row));
    const afterPartialEvents = await actual.collection(names.events).find({ channelID: partialChannel }).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(afterPartialEvents), normalize([...partialEvents].sort((a, b) => String(a._id).localeCompare(String(b._id)))),
        'partial history failure and retry must not mutate source events');
    console.log('PASS actual partial unordered history bulk failure preserves sibling writes, publishes no summary, and recovers with exact TS parity without doubled follows');

    const failure = 'fixture-write-failure';
    await queue(actual, failure);
    await actual.command({ collMod: names.summary, validator: { $or: [{ _id: { $ne: failure } }, { payload: { $exists: false } }] },
        validationLevel: 'strict', validationAction: 'error' });
    const failingPid = paused.pid; resume(paused);
    await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: failure });
        return row?.error === true && +row.leaseUntil === 0 && +row.nextRefreshAt > Date.now();
    }, 'MongoDB 121 releases lease and schedules safe retry');
    assert.equal((await actual.collection(names.summary).findOne({ _id: failure })).payload, undefined);
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.frame.success === false), 'actual failed batch protocol');
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== failingPid; }, 'failed native replacement');
    paused = await pause();
    await actual.command({ collMod: names.summary, validator: {}, validationLevel: 'strict' });
    await queue(actual, failure); resume(paused); await refreshed(failure); paused = await pause();
    console.log('PASS real MongoDB validator failure is observable, never publishes a partial payload, and safely retries after repair');

    const killed = paused; stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'raid-only restart');
    assert.equal(replacement.supervisor, root); await assertNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    assert((await records()).some(row => row.event === 'exit' && row.pid === killed.pid && row.signal === 'SIGKILL'));
    // Verify replacement actually projects rather than merely remaining alive.
    await queue(actual, 'fixture-after-restart'); await refreshed('fixture-after-restart');
    console.log('PASS SIGKILL replaces only raid Rust, unrelated workers remain untouched, and replacement projects successfully');
    await waitFor(telemetry, 'actual RSS/CPU, batch/error/restart metrics in analytics-valid Redis envelopes', 35000);
    console.log('PASS actual native RSS/CPU and batch/error/restart telemetry reaches the existing analytics inbox');

    const shutdown = fixtureDatabase('shutdown'), shutdownUri = new URL(uri.href);
    shutdownUri.pathname = `/${shutdown.databaseName}`;
    const child = spawn(process.execPath, ['/app/dist/workers/cron.index.js'], { cwd: '/app',
        env: { ...process.env, MONGO_URI: shutdownUri.href, RAID_ANALYTICS_FIXTURE_SCOPE: 'shutdown' }, stdio: ['ignore', 'pipe', 'pipe'] });
    auxiliary.add(child);
    let output = ''; const capture = data => { output = (output + data).slice(-4000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.fixtureCompletion = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.fixtureCompletion.catch(() => {});
    const ownedChild = await waitFor(() => currentNative('shutdown'), 'auxiliary native startup');
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch'), 'auxiliary native functional idle');
    child.kill('SIGTERM');
    const exit = await bounded(child.fixtureCompletion, 15000, 'auxiliary graceful shutdown'); auxiliary.delete(child);
    assert.equal(exit.code, 0, output); assert.equal(exit.signal, null);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === ownedChild.pid
        && row.code === 0 && row.signal === null), 'native graceful exit');
    await delay(1200);
    assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1);
    assert(await currentNative(), 'main candidate supervisor remains healthy');
    console.log('PASS actual auxiliary supervisor SIGTERM gracefully stops Rust without restart');
} finally {
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of auxiliary) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...auxiliary].map(async child => {
        try { await bounded(child.fixtureCompletion, 5000, 'cleanup SIGTERM'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.fixtureCompletion.catch(() => {}), 2000, 'cleanup SIGKILL').catch(() => {}); }
    }));
    await bounded(mongoose.disconnect(), 5000, 'reference disconnect').catch(() => {});
    // Helper destroys this candidate/dependency network immediately afterwards.
    // Drop only fixture-owned databases; every driver operation has a 5s cap.
    try { for (const name of owned) {
        assert.match(name, /^raid_analytics_fixture_[a-zA-Z0-9_]+$/); await client.db(name).dropDatabase();
    } } finally { await bounded(client.close(), 5000, 'client close').catch(() => {}); if (redis.isOpen) redis.destroy(); }
}
async function bounded(promise, timeout, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    })]); } finally { clearTimeout(timer); }
}
