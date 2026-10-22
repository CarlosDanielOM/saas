// Stage native-cron-fixture.mjs beside cron-boot.mjs for dual-supervisor verification.
import { rustRegistry, assertSelectedNatives } from '/tmp/saas-fixtures/native-cron-fixture.mjs';
// Change-driven regression check of the real cron command and native raid binary.
// Includes the earlier parity, failure, lease, restart, shutdown and telemetry coverage.
// --fixtures must contain this check's cron-boot.mjs and the exact source
// dima-analytics/src/store.mjs renamed analytics-store.mjs. No live env is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire('/app/package.json');
const { MongoClient, ObjectId, BSON } = require('mongodb');
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
// Leave time for fixture cleanup before the helper's 300-second command limit.
const deadline = Date.now() + 270000;
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
async function referenceAt(id, at) {
    await mongoose.disconnect();
    await mongoose.connect(uri.href, { dbName: baseline.databaseName, serverSelectionTimeoutMS: 5000 });
    await baseline.collection(names.summary).updateMany({ _id: { $ne: id } },
        { $set: { nextRefreshAt: new Date(at + DAY) } });
    await queue(baseline, id);
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
    return baseline.collection(names.summary).findOne({ _id: id });
}
async function compare(state) {
    const at = +state.payload['7'].to;
    assert.equal(+state.payload['30'].to, at);
    const expected = await referenceAt(state._id, at);
    assert.deepEqual(comparablePayload(state.payload), comparablePayload(expected.payload), 'complete persisted payload must match unchanged TypeScript');
    assert.equal(+state.updatedAt, at);
    assert(+state.nextRefreshAt > at, 'successful projection must persist a future maintenance deadline');
    const query = { channelID: state._id, expiresAt: { $gt: new Date(at) } };
    const actualRows = await actual.collection(names.history).find(query).sort({ _id: 1 }).toArray();
    const expectedRows = await baseline.collection(names.history).find(query).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(actualRows), normalize(expectedRows), 'follow counts, open/closed windows and defaults persist identically');
    return expected;
}
// Encode an authentic previous-day fingerprint when preparing restart fixtures.
// The fixture uses only retained outgoing history, so no derived-follow schedule
// or asynchronous mutation can affect the prior-day source bytes.
function outgoingFingerprint(rows, at) {
    const from = days => Math.floor(at / DAY) * DAY - (days - 1) * DAY;
    const digest = createHash('sha256'); let hasPeriodRows = false;
    for (const row of [...rows].sort((a, b) => +b.occurredAt - +a.occurredAt || String(a._id).localeCompare(String(b._id)))) {
        assert.equal(row.direction, 'outgoing');
        if (+row.expiresAt <= at || +row.occurredAt > at) continue;
        const inPeriod = +row.occurredAt >= from(30);
        hasPeriodRows ||= inPeriod;
        const fields = inPeriod ? ['_id', 'direction', 'peerID', 'peerLogin', 'peerName', 'viewers', 'occurredAt', 'followsAfter', 'followWindowEnd']
            : ['_id', 'direction', 'peerID', 'occurredAt'];
        const source = Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]));
        const bytes = BSON.serialize(source), length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length));
        digest.update(length); digest.update(bytes);
    }
    if (hasPeriodRows) for (const days of [7, 30]) { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(from(days))); digest.update(bytes); }
    return digest.digest('hex');
}
async function unchangedPass(id, previous, paused, overrides = {}) {
    const stagedAt = Date.now();
    const beforeFrames = (await records()).length;
    const historyBefore = await actual.collection(names.history).find({ channelID: id }).sort({ _id: 1 }).toArray();
    await actual.collection(names.summary).updateMany({ _id: { $ne: id } },
        { $set: { nextRefreshAt: new Date(stagedAt + DAY) } });
    await queue(actual, id, { dirtyAt: new Date(stagedAt), ...overrides });
    resume(paused);
    const state = await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: id });
        return row?.owner !== previous.owner && +row.leaseUntil === 0 && row.error === false
            && +row.nextRefreshAt > stagedAt ? row : null;
    }, `unchanged pass ${id}`);
    await waitFor(async () => (await records()).slice(beforeFrames).some(row => row.event === 'batch'
        && row.frame.event === 'batch' && row.frame.success && row.frame.phases?.releaseMs !== undefined),
        `unchanged pass ${id} completed protocol`);
    const frames = (await records()).slice(beforeFrames).filter(row => row.event === 'batch'
        && row.frame.event === 'batch' && row.frame.success);
    assert(frames.some(row => row.frame.phases?.followQueriesMs !== undefined), 'unchanged work still runs bounded follow checks');
    for (const row of frames.filter(row => row.frame.phases?.releaseMs !== undefined))
        assert.equal(row.frame.events, 0, 'public count reports changed summaries, not maintenance-only claims');
    for (const row of frames) for (const key of ['period7Ms', 'period30Ms', 'reciprocityMs'])
        assert.equal(row.frame.phases?.[key], undefined, `unchanged work must skip ${key}`);
    if (!Object.hasOwn(overrides, 'rustRefresh.nextRepairAt')) {
        for (const row of frames) assert.equal(row.frame.phases?.followWriteMs, undefined,
            'unchanged fresh/open checks must not write history fields');
        const historyAfter = await actual.collection(names.history).find({ channelID: id }).sort({ _id: 1 }).toArray();
        assert.deepEqual(normalize(historyAfter), normalize(historyBefore), 'unchanged fresh/open history remains byte-equivalent');
    }
    assert.equal(+state.updatedAt, +previous.updatedAt, 'unchanged count must preserve payload timestamp');
    assert.deepEqual(normalize(state.payload), normalize(previous.payload), 'unchanged count must preserve full persisted payload');
    return state;
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
    for (const row of rows.filter(row => row.event === 'batch' && row.frame.event === 'batch')) {
        const value = row.frame;
        assert.equal(value.event, 'batch'); assert([0, 1].includes(value.events));
        assert(Number.isFinite(value.durationMs) && value.durationMs >= 0); assert.equal(typeof value.success, 'boolean');
        if (value.phases) for (const [name, elapsed] of Object.entries(value.phases)) {
            assert(phaseNames.includes(name), 'only fixed source-backed phases');
            assert(Number.isFinite(elapsed) && elapsed >= 0);
        }
    }
}
const phaseNames = ['claimMs', 'followQueriesMs', 'followWriteMs', 'period7Ms', 'period30Ms', 'reciprocityMs', 'publishMs', 'releaseMs'];
async function telemetry() {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
    for (const batch of batches) validateBatch(batch);
    const rows = batches.flatMap(batch => batch.metrics.map(metric => ({ ...metric, service: batch.service })))
        .filter(row => row.name.startsWith('raid_analytics_rust.'));
    const allowed = new Set(['rss_bytes', 'cpu_cores', 'batch_channels', 'project_batch', 'errors', 'restarts',
        'health_query', 'health_errors', 'backlog_channels', 'oldest_due_age_ms', 'last_success_age_ms', ...phaseNames.map(name => `phase.${name}`)]);
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
        && has('errors', row => row.sum > 0) && has('restarts', row => row.sum > 0)
        && phaseNames.every(name => has(`phase.${name}`, row => row.kind === 'queue_run' && row.outcome === 'ok'))
        && has('health_errors', row => row.kind === 'worker' && row.outcome === 'error' && row.sum > 0)
        && has('health_query', row => row.kind === 'worker' && row.outcome === 'ok' && row.sum > 0)
        && has('backlog_channels', row => row.kind === 'worker' && row.max > 0)
        && has('backlog_channels', row => row.kind === 'worker' && row.sum === 0 && row.max === 0)
        && has('oldest_due_age_ms', row => row.kind === 'worker' && row.max > 0)
        && has('last_success_age_ms', row => row.kind === 'worker');
}

try {
    await client.connect(); await redis.connect();
    const native = await waitFor(() => currentNative(), 'actual supervisor starts native raid worker');
    assertSelectedNatives(await records(), ['raid-analytics']);
    assert.equal(rustRegistry().find(worker => worker.name === 'raid-analytics').binary, '/usr/local/bin/raid_analytics');
    const root = native.supervisor;
    await assertNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    assert(unrelated.includes('follow-ledger'), 'active TS workers remain inert siblings');
    assert(unrelated.includes('domain-events'), 'event-producing workers must be inert');
    const idle = await waitFor(async () => {
        const rows = (await records()).filter(row => row.event === 'batch' && row.frame.event === 'batch' && row.frame.success && row.frame.events === 0);
        return rows.length >= 3 ? rows.slice(0, 3) : null;
    }, 'natural idle backoff', 12000);
    const gaps = [idle[1].at - idle[0].at, idle[2].at - idle[1].at];
    assert(gaps[0] >= 700 && gaps[1] >= gaps[0] * 1.3, 'idle polling should back off rather than hot-loop');
    console.log('PASS natural idle polling increases its delay without a busy loop');
    const initialHealth = await waitFor(async () => (await records()).find(row => row.event === 'batch'
        && row.pid === native.pid && row.frame.event === 'health'), 'initial native health frame');
    assert.equal(initialHealth.frame.lastSuccessAgeMs, undefined, 'fresh native child must not fabricate last-success age');
    if (initialHealth.frame.success) {
        assert.equal(initialHealth.frame.dueChannels, 0);
        assert.equal(initialHealth.frame.oldestDueAgeMs, undefined);
    } else {
        assert.equal(initialHealth.frame.dueChannels, undefined);
        assert.equal(initialHealth.frame.oldestDueAgeMs, undefined);
    }
    assert.equal((await currentNative()).pid, native.pid);
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

    // A producer may redirty an existing raid without inserting anything. Open
    // windows and elapsed .to values alone must not cause aggregate publication.
    state = await unchangedPass(channel, state, paused);
    paused = await pause();
    assert.deepEqual(comparablePayload(state.payload), firstPayload);
    // Keep the exact reference parity cohort closed after verifying open no-op
    // behavior: the new contract intentionally retains an unchanged open end.
    for (const db of [actual, baseline]) await db.collection(names.history).deleteOne({ _id: 'open' });
    const late = follow(fixtureNow - 3600000 + 650000, { _id: new ObjectId('000000000000000000000001') });
    for (const db of [actual, baseline]) {
        await db.collection(names.events).insertOne(late);
        await db.collection(names.history).updateOne({ _id: 'closed' }, { $set: { followsComputedAt: new Date(0) } });
    }
    // A retained late event can have an ObjectId older than every prior event.
    // Force only persisted repair scheduling; no handler/watermark is involved.
    await queue(actual, channel, { 'rustRefresh.nextRepairAt': new Date(0) }); resume(paused);
    state = await refreshed(channel, +state.updatedAt); paused = await pause(); await compare(state);
    assert.equal((await actual.collection(names.history).findOne({ _id: 'closed' })).followsAfter, 3);
    const sourceAfter = await actual.collection(names.events).find({ expiresAt: { $gt: new Date() }, _id: { $ne: late._id } }).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(sourceAfter), sourceSnapshot, 'native projector never mutates or creates source domain events');
    console.log('PASS duplicate/redirty and open no-change skip full aggregates; lower-ObjectId retained follows repair closed windows with exact TS payload parity');

    const openChannel = 'fixture-open-change';
    const openRaid = history('open-change', 'incoming', 'open-peer', Date.now() - 20000, { channelID: openChannel });
    await actual.collection(names.history).insertOne(openRaid);
    await queue(actual, openChannel); resume(paused);
    let openState = await refreshed(openChannel); paused = await pause();
    assert.equal((await actual.collection(names.history).findOne({ _id: openRaid._id })).followsAfter, 0);
    openState = await unchangedPass(openChannel, openState, paused); paused = await pause();
    const openFollow = follow(+openRaid.occurredAt + 10000, { channelID: openChannel });
    await actual.collection(names.events).insertOne(openFollow);
    await queue(actual, openChannel); resume(paused);
    openState = await refreshed(openChannel, +openState.updatedAt); paused = await pause();
    assert.equal(openState.payload['7'].totals.find(row => row._id === 'incoming').followsAfter, 1);
    assert.equal(openState.payload['7'].incoming[0].followsAfter, 1);
    assert.equal((await actual.collection(names.history).findOne({ _id: openRaid._id })).followsAfter, 1);
    openState = await unchangedPass(openChannel, openState, paused); paused = await pause();
    console.log('PASS open window preserves full payload without new follows, publishes changed count, then skips again');

    // Failure after a previously bootstrapped channel changes a count is more
    // demanding than first-publication failure: the retry sees no new count
    // delta because the history write already committed, but must still rebuild.
    const retryFollow = follow(+openRaid.occurredAt + 11000, { channelID: openChannel });
    await actual.collection(names.events).insertOne(retryFollow);
    await actual.command({ collMod: names.summary, validator: { $or: [
        { _id: { $ne: openChannel } }, { 'payload.7.incoming.0.followsAfter': { $ne: 2 } }
    ] }, validationLevel: 'strict', validationAction: 'error' });
    await queue(actual, openChannel, { dirtyAt: new Date() });
    const retryFailurePid = paused.pid; resume(paused);
    const failedExisting = await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: openChannel });
        return row?.error === true && +row.leaseUntil === 0 ? row : null;
    }, 'existing metadata publication failure retains retry state');
    assert.deepEqual(normalize(failedExisting.payload), normalize(openState.payload), 'failed publication preserves prior complete payload');
    assert.equal(failedExisting.rustRefresh.fingerprint, openState.rustRefresh.fingerprint, 'failed publication cannot advance the durable source fingerprint');
    assert.equal((await actual.collection(names.history).findOne({ _id: openRaid._id })).followsAfter, 2,
        'count write committed before summary publication failed');
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== retryFailurePid; }, 'existing-state failure replacement');
    paused = await pause();
    await actual.command({ collMod: names.summary, validator: {}, validationLevel: 'strict' });
    await actual.collection(names.summary).updateOne({ _id: openChannel }, { $set: { nextRefreshAt: new Date(0) } });
    resume(paused);
    openState = await refreshed(openChannel, +openState.updatedAt); paused = await pause();
    assert.equal(openState.payload['7'].incoming[0].followsAfter, 2);
    assert.equal(openState.payload['7'].totals.find(row => row._id === 'incoming').followsAfter, 2);
    assert.equal(+openState.dirtyAt, +failedExisting.dirtyAt, 'retry succeeds without manufacturing a new dirty event');
    assert.notEqual(openState.rustRefresh.fingerprint, failedExisting.rustRefresh.fingerprint);
    console.log('PASS existing fingerprint survives failed publication; restart retries already-written count without a new dirty event');

    // A new actual history row queues a rebuild; requeueing the exact retained
    // row does not. Source producers and their TypeScript implementation stay intact.
    const added = history('new-actual-raid', 'outgoing', 'new-peer', Date.now() - 1000, { channelID: channel });
    for (const db of [actual, baseline]) await db.collection(names.history).insertOne(added);
    await queue(actual, channel, { dirtyAt: new Date() }); resume(paused);
    state = await refreshed(channel, +state.updatedAt); paused = await pause(); await compare(state);
    assert(state.payload['7'].outgoing.some(row => row.peerID === 'new-peer'));
    state = await unchangedPass(channel, state, paused); paused = await pause();
    console.log('PASS queued actual raid changes rebuild with exact TypeScript payload parity and duplicate requeue skips');
    const closedQuery = { channelID: channel, direction: 'incoming', occurredAt: {
        $gte: new Date(Math.floor(Date.now() / DAY) * DAY - 29 * DAY), $lte: new Date()
    }, expiresAt: { $gt: new Date() } };
    const closedBefore = await actual.collection(names.history).find(closedQuery).sort({ _id: 1 }).toArray();
    await actual.collection(names.history).updateMany(closedQuery, { $set: { followsComputedAt: new Date(0) } });
    state = await unchangedPass(channel, state, paused, { 'rustRefresh.nextRepairAt': new Date(0) }); paused = await pause();
    const closedAfter = await actual.collection(names.history).find(closedQuery).sort({ _id: 1 }).toArray();
    const businessHistory = rows => rows.map(({ followsComputedAt, ...row }) => row);
    assert.deepEqual(normalize(businessHistory(closedAfter)), normalize(businessHistory(closedBefore)),
        'unchanged closed repair must preserve count/end and every business field');
    assert(closedAfter.every(row => +row.followsComputedAt > 0), 'bounded repair advances stale scheduling timestamps');
    console.log('PASS unchanged closed follow repair advances eligibility timestamps while preserving counts/end/payload and omitting full aggregates');

    // Exercise real wall-clock expiry and future activation using short-lived
    // outgoing rows, which cannot be confused with follow-window changes.
    const boundaryChannel = 'fixture-source-boundaries';
    const boundaryNow = Date.now();
    const expiring = history('boundary-expiry', 'outgoing', 'expires-peer', boundaryNow - 10000,
        { channelID: boundaryChannel, expiresAt: new Date(boundaryNow + 8000) });
    const futureRaid = history('boundary-future', 'outgoing', 'future-peer', boundaryNow + 16000,
        { channelID: boundaryChannel });
    await actual.collection(names.history).insertMany([expiring, futureRaid]);
    await queue(actual, boundaryChannel); resume(paused);
    let boundaryState = await refreshed(boundaryChannel); paused = await pause();
    assert.deepEqual(boundaryState.payload['7'].outgoing.map(row => row.peerID), ['expires-peer']);
    assert(+boundaryState.nextRefreshAt <= +expiring.expiresAt, 'expiry must be a persisted maintenance boundary');
    resume(paused);
    boundaryState = await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: boundaryChannel });
        return row?.payload && +row.updatedAt >= +expiring.expiresAt
            && row.payload['7'].outgoing.length === 0 && +row.leaseUntil === 0 ? row : null;
    }, 'history expiry rebuild without producer queue'); paused = await pause();
    assert(+boundaryState.nextRefreshAt <= +futureRaid.occurredAt, 'future row activation must remain scheduled');
    resume(paused);
    boundaryState = await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: boundaryChannel });
        return row?.payload?.['7'].outgoing.some(item => item.peerID === 'future-peer') && +row.leaseUntil === 0 ? row : null;
    }, 'future activation rebuild without producer queue'); paused = await pause();
    assert(!boundaryState.payload['7'].outgoing.some(row => row.peerID === 'expires-peer'));
    const nextMidnight = (Math.floor(Date.now() / DAY) + 1) * DAY;
    assert(boundaryState.rustRefresh?.nextSourceAt instanceof Date);
    assert(+boundaryState.rustRefresh.nextSourceAt <= nextMidnight, 'UTC range rollover must be persisted no later than midnight');
    console.log('PASS persisted source deadlines rebuild on actual expiry/future activation and include the next UTC range rollover');

    const rolloverChannel = 'fixture-utc-rollover', today = Math.floor(Date.now() / DAY) * DAY, previousDay = today - 1;
    const rolloverRows = [
        history('rollover-stays', 'outgoing', 'stays-peer', today - DAY, { channelID: rolloverChannel }),
        history('rollover-seven', 'outgoing', 'seven-peer', today - 7 * DAY + 1, { channelID: rolloverChannel }),
        history('rollover-thirty', 'outgoing', 'thirty-peer', today - 30 * DAY + 1, { channelID: rolloverChannel })
    ];
    for (const db of [actual, baseline]) await db.collection(names.history).insertMany(rolloverRows);
    const priorSummary = await referenceAt(rolloverChannel, previousDay);
    assert.equal(priorSummary.payload['7'].totals[0].raids, 2);
    assert.equal(priorSummary.payload['30'].totals[0].raids, 3);
    await actual.collection(names.summary).insertOne({ ...priorSummary,
        dirtyAt: new Date(0), leaseUntil: new Date(0), nextRefreshAt: new Date(today), rustPending: false,
        rustRefresh: { version: 1, fingerprint: outgoingFingerprint(rolloverRows, previousDay),
            nextSourceAt: new Date(today), nextRepairAt: null, nextOpenAt: null, dirtyAt: new Date(0), hasFollowWindows: false }
    });
    resume(paused);
    const rolled = await refreshed(rolloverChannel, previousDay); paused = await pause(); await compare(rolled);
    assert.equal(+rolled.dirtyAt, 0, 'rollover requires no new dirty event');
    assert.equal(+rolled.payload['7'].from, today - 6 * DAY);
    assert.equal(+rolled.payload['30'].from, today - 29 * DAY);
    assert.equal(rolled.payload['7'].totals[0].raids, 1);
    assert.equal(rolled.payload['30'].totals[0].raids, 2);
    assert(!rolled.payload['7'].outgoing.some(row => row.peerID === 'seven-peer'));
    assert(!rolled.payload['30'].outgoing.some(row => row.peerID === 'thirty-peer'));
    assert(rolled.payload['30'].outgoing.some(row => row.peerID === 'seven-peer'));
    console.log('PASS actual native UTC rollover recovery from authentic persisted previous-day fingerprint removes 7/30-day boundary rows with exact TS parity');

    const adoptionChannel = 'fixture-cache-adoption';
    const adoptionRow = history('cache-adoption-raid', 'outgoing', 'cache-adoption-peer', Date.now() - 10000,
        { channelID: adoptionChannel });
    for (const db of [actual, baseline]) await db.collection(names.history).insertOne(adoptionRow);
    const cached = await referenceAt(adoptionChannel, Date.now() - 1000);
    await actual.collection(names.summary).insertOne({ ...cached, leaseUntil: new Date(0), nextRefreshAt: new Date(0) });
    const adoptionFramesAt = (await records()).length; resume(paused);
    let adopted = await waitFor(async () => {
        const row = await actual.collection(names.summary).findOne({ _id: adoptionChannel });
        return row?.rustRefresh?.version === 1 && +row.leaseUntil === 0 ? row : null;
    }, 'existing cache gains source metadata once');
    await waitFor(async () => (await records()).slice(adoptionFramesAt).some(row => row.event === 'batch'
        && row.frame.event === 'batch' && row.frame.phases?.period7Ms !== undefined), 'adoption aggregates completed');
    paused = await pause();
    assert.equal(+adopted.updatedAt, +cached.updatedAt, 'adopting a semantically identical cache preserves updatedAt');
    assert.deepEqual(normalize(adopted.payload), normalize(cached.payload), 'adoption preserves the exact existing business payload');
    adopted = await unchangedPass(adoptionChannel, adopted, paused); paused = await pause();
    console.log('PASS one-time metadata adoption may aggregate but retains unchanged cached payload/timestamp; subsequent dirty recheck skips aggregates');
    const sameTimestamp = adopted.dirtyAt;
    const sameTimestampRaid = history('same-timestamp-raid', 'outgoing', 'same-timestamp-peer', Date.now() - 500,
        { channelID: adoptionChannel });
    for (const db of [actual, baseline]) await db.collection(names.history).insertOne(sameTimestampRaid);
    await queue(actual, adoptionChannel, { dirtyAt: sameTimestamp, nextRefreshAt: sameTimestamp }); resume(paused);
    adopted = await refreshed(adoptionChannel, +adopted.updatedAt); paused = await pause(); await compare(adopted);
    assert.equal(+adopted.dirtyAt, +sameTimestamp, 'actual source addition retains the remembered dirty timestamp');
    assert.equal(adopted.payload['7'].totals[0].raids, 2);
    adopted = await unchangedPass(adoptionChannel, adopted, paused,
        { dirtyAt: sameTimestamp, nextRefreshAt: sameTimestamp }); paused = await pause();
    console.log('PASS same-timestamp producer queue fingerprints new history and rebuilds; identical-timestamp duplicate still skips aggregates');

    const held = 'fixture-held';
    await queue(actual, held, { owner: 'other-owner', leaseUntil: new Date(Date.now() + 600000) });
    const before = (await records()).filter(row => row.event === 'batch' && row.frame.event === 'batch').length;
    resume(paused);
    await waitFor(async () => (await records()).filter(row => row.event === 'batch' && row.frame.event === 'batch').length > before, 'worker observes owner-held queue');
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
    const partialRaids = Array.from({ length: 40 }, (_, i) => history(`partial-history-${String(i).padStart(2, '0')}`, 'incoming', `partial-peer-${i}`,
        fixtureNow - 12 * 3600000 + i * 600000, { channelID: partialChannel }));
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
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.frame.event === 'batch'
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
    await waitFor(async () => await actual.collection(names.history).countDocuments({ channelID: partialChannel, followsAfter: 1 }) === partialRaids.length,
        '>25 same-channel follow windows drain across bounded batches', 12000);
    const recoveredPartial = await refreshed(partialChannel); paused = await pause();
    // Reference starts from the exact recovered row state, preserving the native
    // scheduler's per-batch completion timestamps while checking business output.
    for (const row of await actual.collection(names.history).find({ channelID: partialChannel }).toArray())
        await baseline.collection(names.history).replaceOne({ _id: row._id }, row);
    await compare(recoveredPartial);
    const repairedRows = await actual.collection(names.history).find({ channelID: partialChannel }).sort({ _id: 1 }).toArray();
    assert(repairedRows.every(row => row.followsAfter === 1), 'retry recomputes missing counts without doubling siblings');
    for (const row of persisted) assert.deepEqual(normalize(repairedRows.find(repaired => repaired._id === row._id)), normalize(row));
    const afterPartialEvents = await actual.collection(names.events).find({ channelID: partialChannel }).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(afterPartialEvents), normalize([...partialEvents].sort((a, b) => String(a._id).localeCompare(String(b._id)))),
        'partial history failure and retry must not mutate source events');
    console.log('PASS >25 follow-window backlog drains after actual partial unordered bulk failure, retaining siblings, exact TS payload parity and undoubled counts');

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
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.frame.event === 'batch' && row.frame.success === false), 'actual failed batch protocol');
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== failingPid; }, 'failed native replacement');
    paused = await pause();
    await actual.command({ collMod: names.summary, validator: {}, validationLevel: 'strict' });
    await queue(actual, failure); resume(paused); await refreshed(failure); paused = await pause();
    console.log('PASS real MongoDB validator failure is observable, never publishes a partial payload, and safely retries after repair');

    // Quiet channels persist source maintenance deadlines beyond the old minute
    // refresh. They also supply a restart test with already bootstrapped state.
    const quietIds = Array.from({ length: 75 }, (_, i) => `fixture-quiet-${i}`);
    const quietRaids = quietIds.map((id, i) => history(`quiet-raid-${i}`, 'outgoing', `quiet-peer-${i}`,
        fixtureNow - 2 * DAY, { channelID: id }));
    await actual.collection(names.summary).updateMany({}, { $set: { nextRefreshAt: new Date(Date.now() + DAY) } });
    await actual.collection(names.history).insertMany(quietRaids);
    for (const id of quietIds) await queue(actual, id);
    resume(paused);
    await waitFor(async () => await actual.collection(names.summary).countDocuments({ _id: { $in: quietIds },
        payload: { $exists: true }, error: false, leaseUntil: new Date(0) }) === quietIds.length,
        '75 quiet summaries bootstrap', 15000);
    paused = await pause();
    const quietStates = await actual.collection(names.summary).find({ _id: { $in: quietIds } }).sort({ _id: 1 }).toArray();
    for (const row of quietStates) {
        assert.equal(row.rustRefresh?.version, 1, 'quiet metadata is durably versioned');
        assert.equal(typeof row.rustRefresh?.fingerprint, 'string');
        assert(row.rustRefresh.fingerprint.length > 0);
        assert(+row.nextRefreshAt > Date.now() + 65000, 'quiet schedule must exceed the old one-minute rebuild');
    }
    const quietStarted = Date.now();
    const killed = paused; stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'raid-only restart');
    assert.equal(replacement.supervisor, root); await assertNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    assert((await records()).some(row => row.event === 'exit' && row.pid === killed.pid && row.signal === 'SIGKILL'));
    // Verify replacement actually projects rather than merely remaining alive.
    await queue(actual, 'fixture-after-restart'); await refreshed('fixture-after-restart');
    console.log('PASS SIGKILL replaces only raid Rust, unrelated workers remain untouched, and replacement projects successfully');
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.pid === replacement.pid
        && row.frame.event === 'batch' && row.frame.phases?.period7Ms !== undefined), 'replacement projection frame emitted');
    const quietFramesAt = (await records()).length;

    const shutdown = fixtureDatabase('shutdown'), shutdownUri = new URL(uri.href);
    shutdownUri.pathname = `/${shutdown.databaseName}`;
    await indexes(shutdown);
    // A leased due row is pending work even though this child cannot claim it.
    await queue(shutdown, 'fixture-health-held', { owner: 'fixture-held-owner', leaseUntil: new Date(Date.now() + 600000) });
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
    const heldHealth = await waitFor(async () => (await records('shutdown')).find(row => row.event === 'batch'
        && row.pid === ownedChild.pid && row.frame.event === 'health' && row.frame.success), 'actual held backlog health frame');
    assert.equal(heldHealth.frame.dueChannels, 1);
    assert(Number.isFinite(heldHealth.frame.oldestDueAgeMs) && heldHealth.frame.oldestDueAgeMs > 0);
    assert.equal(heldHealth.frame.lastSuccessAgeMs, undefined, 'fresh child has no invented last successful refresh');
    // Explicitly remove only this fixture's due index after the successful
    // sample. A missing collection can bypass hint validation in MongoDB;
    // this existing collection makes the real query failure deterministic.
    const dueIndex = (await shutdown.collection(names.summary).listIndexes().toArray()).find(index =>
        JSON.stringify(index.key) === JSON.stringify({ nextRefreshAt: 1, leaseUntil: 1 }));
    assert(dueIndex);
    await shutdown.collection(names.summary).dropIndex(dueIndex.name);
    const failedHealth = await waitFor(async () => (await records('shutdown')).find(row => row.event === 'batch'
        && row.pid === ownedChild.pid && row.at > heldHealth.at && row.frame.event === 'health' && !row.frame.success),
        'real dropped-index health query failure', 40000);
    for (const key of ['dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs'])
        assert.equal(failedHealth.frame[key], undefined, 'failed/unknown gauges must be omitted, never fabricated as zero');
    assert.equal((await currentNative('shutdown')).pid, ownedChild.pid, 'health failure must not kill the projector');
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch' && row.pid === ownedChild.pid
        && row.at >= failedHealth.at && row.frame.event === 'batch' && row.frame.success), 'projection continues after health query failure');
    await waitFor(async () => {
        const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
        for (const batch of batches) validateBatch(batch);
        const bucket = Math.floor(failedHealth.at / 10000) * 10000;
        const failure = batches.find(batch => batch.metrics.some(row => row.name === 'raid_analytics_rust.health_errors'
            && row.at >= bucket - 10000 && row.at <= bucket)
            && batch.metrics.some(row => row.name === 'raid_analytics_rust.health_query' && row.sum === 0));
        if (!failure) return false;
        const failedAt = failure.metrics.find(row => row.name === 'raid_analytics_rust.health_query' && row.sum === 0).at;
        assert(!failure.metrics.some(row => ['raid_analytics_rust.backlog_channels', 'raid_analytics_rust.oldest_due_age_ms'].includes(row.name)
            && row.at === failedAt), 'failed health queries must not create zero backlog/oldest gauges in real Redis envelopes');
        return true;
    }, 'failed health query reaches Redis without fabricated backlog gauges', 15000);
    await shutdown.collection(names.summary).createIndex({ nextRefreshAt: 1, leaseUntil: 1 });
    await shutdown.collection(names.summary).deleteOne({ _id: 'fixture-health-held' });
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch' && row.pid === ownedChild.pid
        && row.frame.event === 'health' && row.frame.success && row.frame.dueChannels === 0
        && row.frame.oldestDueAgeMs === undefined && row.frame.lastSuccessAgeMs === undefined), 'actual empty backlog health frame', 40000);
    assert.equal((await currentNative('shutdown')).pid, ownedChild.pid);
    console.log('PASS real held backlog, dropped-index health failure without worker death/fabricated gauges, and repaired zero backlog reach native health frames');
    await waitFor(telemetry, 'actual runtime/phase/health/error/restart metrics in analytics-valid Redis envelopes', 35000);
    console.log('PASS generic runtime/batch metrics plus every phase and health gauge reach analytics-valid Redis envelopes');
    child.kill('SIGTERM');
    const exit = await bounded(child.fixtureCompletion, 15000, 'auxiliary graceful shutdown'); auxiliary.delete(child);
    assert.equal(exit.code, 0, output); assert.equal(exit.signal, null);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === ownedChild.pid
        && row.code === 0 && row.signal === null), 'native graceful exit');
    await delay(1200);
    assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1);
    assert(await currentNative(), 'main candidate supervisor remains healthy');
    console.log('PASS actual auxiliary supervisor SIGTERM gracefully stops Rust without restart');

    await waitFor(() => Date.now() - quietStarted >= 65000, 'quiet observation exceeds one minute', 70000);
    paused = await pause();
    const quietAfter = await actual.collection(names.summary).find({ _id: { $in: quietIds } }).sort({ _id: 1 }).toArray();
    assert.deepEqual(normalize(quietAfter), normalize(quietStates), '75 quiet summaries remain byte-equivalent across restart and >60 seconds');
    const quietFrames = (await records()).slice(quietFramesAt).filter(row => row.event === 'batch' && row.frame.event === 'batch');
    assert(quietFrames.length >= 3, 'replacement continues polling during quiet observation');
    for (const row of quietFrames) for (const key of ['period7Ms', 'period30Ms', 'reciprocityMs'])
        assert.equal(row.frame.phases?.[key], undefined, 'quiet restart must not repeat full aggregation');
    assert.equal((await currentNative()).pid, replacement.pid, 'quiet restart remains stable');
    const changedQuiet = quietIds[0], beforeQuiet = quietStates.find(row => row._id === changedQuiet);
    await actual.collection(names.history).insertOne(history('quiet-new-raid', 'outgoing', 'quiet-new-peer', Date.now() - 1000,
        { channelID: changedQuiet }));
    await queue(actual, changedQuiet, { dirtyAt: new Date() }); resume(paused);
    const rebuiltQuiet = await refreshed(changedQuiet, +beforeQuiet.updatedAt); paused = await pause();
    assert.equal(rebuiltQuiet.payload['7'].totals.find(row => row._id === 'outgoing').raids, 2);
    await unchangedPass(changedQuiet, rebuiltQuiet, paused); paused = await pause();
    console.log(`PASS 75 quiet summaries persist unchanged for ${Date.now() - quietStarted} ms across restart without aggregates; new queued raid rebuilds and duplicate queue skips`);
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
