// Real cron supervisor + native baseline binary. Stage cron-boot.mjs and the exact
// dima-analytics/src/store.mjs as analytics-store.mjs in --fixtures. Disposable
// mongo/redis aliases and fixture database are mandatory; no provider calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire('/app/package.json');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.equal(process.env.DRAGONFLY_HOST, 'redis');
const databaseName = decodeURIComponent(uri.pathname.slice(1));
assert.match(databaseName, /^follow_baseline_fixture_[a-zA-Z0-9_]+$/);
assert([undefined, 'node'].includes(process.env.CRON_WORKER_RUNTIME));
assert.equal(process.env.FOLLOW_DEFENSE_BASELINE_RUNTIME, undefined, 'exercise native default');
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const redis = createClient({ url: `redis://redis:${process.env.DRAGONFLY_PORT || '6379'}`, socket: { reconnectStrategy: false } });
redis.on('error', () => {});
const stopped = new Set(), auxiliary = new Set();
const deadline = Date.now() + 190000;
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"), 'stage exact analytics store source');
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
mongoose.set('autoIndex', false);
const { FollowRelationshipLedgerSchema: Ledger } = await import('/app/dist/schemas/follow_relationship_ledger.schema.js');
const { StreamSessionSchema: Streams } = await import('/app/dist/schemas/stream_session.schema.js');
const { FollowAttackLogSchema: Attacks } = await import('/app/dist/schemas/follow_attack_log.schema.js');
const { refreshDefenseBaseline } = await import('/app/dist/utils/follow_defense_baseline.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { telemetryTesting } = await import('/app/dist/utils/observability/telemetry.js');
let referenceRedis;
const names = { ledger: Ledger.collection.name, streams: Streams.collection.name, attacks: Attacks.collection.name };
const db = client.db(databaseName);
const DUE = 'follow:defense:baseline:due', DAY = 86400000;
const key = id => `follow:defense:baseline:${id}`;
const now = Date.now(), end = Math.floor(now / DAY) * DAY, start = end - 30 * DAY;
async function waitFor(check, label, timeout = 15000) {
    const until = Math.min(deadline, Date.now() + timeout);
    do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < until);
    throw new Error(`Timed out: ${label}`);
}
async function records(scope = 'main') {
    let text;
    try { text = await readFile('/tmp/saas-fixtures/baseline-spawns.jsonl', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), dead = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !dead.has(row.pid)).at(-1);
}
async function pause() {
    const row = await waitFor(() => currentNative(), 'native process to pause');
    process.kill(row.pid, 'SIGSTOP'); stopped.add(row.pid);
    await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`, 'utf8')), 'native paused');
    return row;
}
function resume(row) { process.kill(row.pid, 'SIGCONT'); stopped.delete(row.pid); }
async function queue(id, score = Date.now()) { await redis.zAdd(DUE, [{ value: id, score }]); }
async function refreshed(id, after = 0) {
    return waitFor(async () => {
        const raw = await redis.get(key(id));
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value.calculatedAt > after && Number(await redis.zScore(DUE, id)) > Date.now() + 3500000 ? value : null;
    }, `baseline refresh ${id}`);
}
async function compare(id, value) {
    const ttl = await redis.ttl(key(id));
    assert(ttl >= 7 * 86400 - 15 && ttl <= 7 * 86400, 'native cache TTL is seven days');
    const score = Number(await redis.zScore(DUE, id));
    assert(score >= value.calculatedAt + 3600000 && score <= value.calculatedAt + 3600000 + 10000, 'success next-hour queue receipt');
    // Retain the same process-local singleton used by the unchanged reference
    // refresh so its socket can be closed after all parity assertions finish.
    referenceRedis ??= await getDragonflyClient('follow-defense-baseline.fixture.reference');
    const expected = await refreshDefenseBaseline(id, value.calculatedAt);
    assert.deepEqual(value, expected, 'all persisted JSON fields match unchanged TypeScript refresh at native calculatedAt');
    return value;
}
let rowID = 0;
const ledger = (id, at, extra = {}) => ({ _id: `fixture-ledger-${++rowID}`, followed_id: id, followed_at: new Date(at), ...extra });
const stream = (id, at, follows, extra = {}) => ({ _id: `fixture-stream-${++rowID}`, channelID: id,
    started_at: new Date(at), ended_at: new Date(at + 3600000), status: 'offline', duration_minutes: 60, follows, ...extra });
const attack = (id, at, extra = {}) => ({ targetChannelID: id, modeTriggered: 'attack', createdAt: new Date(at), ...extra });
async function seed(id, kind) {
    const ledgers = [], streams = [], attacks = [];
    const days = kind === 'sparse-days' ? 6 : 8;
    const streamDays = kind === 'sparse-streams' ? 2 : Math.min(days, 4);
    for (let d = 1; d <= days; d++) {
        const at = end - d * DAY + 1000;
        const count = kind === 'daily' ? 2200 : 2;
        for (let i = 0; i < count; i++) ledgers.push(ledger(id, at + i));
        if (d <= streamDays) streams.push(stream(id, at, kind === 'stream' ? 4000 : 20));
    }
    if (kind === 'exclusions') {
        attacks.push(attack(id, end - DAY + 3000), attack(id, end - DAY + 4000), attack(id, now - 1),
            attack(id, start - 1), attack(id, now + DAY), attack(id, end - 2 * DAY, { modeTriggered: 'protection' }),
            attack('fixture-other', end - 3 * DAY));
        // Attack-day follows/streams must be removed; UTC-today attack must not
        // shrink the denominator for the preceding thirty complete UTC days.
        for (let i = 0; i < 100; i++) ledgers.push(ledger(id, end - DAY + 10000 + i));
        streams.push(stream(id, end - DAY + 10000, 999999));
    }
    if (kind === 'boundaries') {
        ledgers.push(ledger(id, start), ledger(id, end - 1), ledger(id, start - 1), ledger(id, end),
            ledger('fixture-other', start), ledger(id, end - 2 * DAY, { platform: 'other', status: 'ended' }));
        streams.push(stream(id, start, 11), stream(id, start - 1, 99999), stream(id, end, 99999),
            stream(id, end - 2 * DAY, 99999, { status: 'live' }),
            stream(id, end - 2 * DAY, 99999, { ended_at: null }),
            stream(id, end - 2 * DAY, 99999, { ended_at: new Date(end + 1) }),
            stream(id, end - 2 * DAY, 99999, { duration_minutes: 0 }),
            stream(id, end - 2 * DAY, 99999, { duration_minutes: -1 }),
            stream('fixture-other', end - 2 * DAY, 99999));
    }
    if (ledgers.length) await db.collection(names.ledger).insertMany(ledgers);
    if (streams.length) await db.collection(names.streams).insertMany(streams);
    if (attacks.length) await db.collection(names.attacks).insertMany(attacks);
}
async function assertNative(root) {
    const rows = (await records()).filter(row => row.supervisor === root);
    const alive = await currentNative(); assert(alive);
    assert.equal(alive.supervisor, root); assert.equal(alive.command, '/usr/local/bin/follow_defense_baseline');
    assert.equal(alive.uid, 65534); assert.equal(alive.gid, 65534);
    const status = await readFile(`/proc/${alive.pid}/status`, 'utf8');
    assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
    assert(Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) > 0);
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
        let cmd; try { cmd = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
        assert(!cmd.split('\0').some(arg => arg.endsWith('/follow_defense_baseline.worker.js')), 'rollback TS child must be absent');
    }
    for (const row of rows.filter(row => row.event === 'batch')) {
        assert.deepEqual(Object.keys(row.frame).sort(), ['durationMs', 'event', 'events', 'success']);
        assert.equal(row.frame.event, 'batch'); assert([0, 1].includes(row.frame.events));
        assert(Number.isFinite(row.frame.durationMs) && row.frame.durationMs >= 0 && row.frame.durationMs <= 300000);
        assert.equal(typeof row.frame.success, 'boolean');
        if (!row.frame.success) assert.equal(row.frame.events, 0);
    }
}
async function telemetry() {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
    for (const batch of batches) validateBatch(batch);
    const rows = batches.flatMap(batch => batch.metrics.map(row => ({ ...row, service: batch.service })))
        .filter(row => row.name.startsWith('follow_defense_baseline_rust.'));
    const allowed = new Set(['rss_bytes', 'cpu_cores', 'batch_channels', 'project_batch', 'errors', 'restarts']);
    for (const row of rows) {
        assert(allowed.has(row.name.slice('follow_defense_baseline_rust.'.length)));
        assert.equal(row.channel, ''); assert.equal(row.service, 'cron'); assert(Number.isFinite(row.sum) && row.sum >= 0);
    }
    const has = (name, check) => rows.some(row => row.name === `follow_defense_baseline_rust.${name}` && check(row));
    return has('rss_bytes', row => row.kind === 'runtime' && row.max > 0)
        && has('cpu_cores', row => row.kind === 'runtime')
        && has('batch_channels', row => row.kind === 'worker' && row.sum > 0)
        && has('project_batch', row => row.outcome === 'error')
        && has('project_batch', row => row.outcome === 'idle')
        && has('errors', row => row.outcome === 'error') && has('restarts', row => row.outcome === 'error');
}
try {
    await client.connect(); await redis.connect();
    await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000 });
    const initial = await waitFor(() => currentNative(), 'native baseline child');
    const root = initial.supervisor; await assertNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    assert(unrelated.includes('raid-analytics') && unrelated.includes('stream-activity'));
    console.log('PASS real supervisor selects only native baseline with restricted env and UID/GID 65534; other workers inert');
    let held = await pause();
    for (const kind of ['daily', 'stream', 'floor', 'sparse-days', 'sparse-streams', 'exclusions', 'boundaries']) await seed(`fixture-${kind}`, kind);
    resume(held);
    for (const kind of ['daily', 'stream', 'floor', 'sparse-days', 'sparse-streams', 'exclusions', 'boundaries']) {
        const id = `fixture-${kind}`; await queue(id);
        const value = await compare(id, await refreshed(id));
        if (kind === 'daily') assert(value.attackThreshold > 500 && value.averageDaily > value.averageStream);
        if (kind === 'stream') assert(value.attackThreshold > 500 && value.averageStream > value.averageDaily);
        if (kind === 'floor') assert.equal(value.attackThreshold, 500);
        if (kind.startsWith('sparse')) assert.equal(value.attackThreshold, null);
        if (kind === 'exclusions') assert.equal(value.excludedDays, 1);
    }
    await queue('fixture-empty'); const empty = await compare('fixture-empty', await refreshed('fixture-empty'));
    assert.equal(empty.sampleDays, 0); assert.equal(empty.attackThreshold, null);
    console.log('PASS unchanged TypeScript JSON parity: daily/stream dominant, minimum500, sparse/null, attack exclusions incl UTC today, eligible streams and 30-day boundaries; seven-day TTL and next-hour scheduling');
    const future = Date.now() + DAY;
    await queue('fixture-future', future); await delay(1200);
    assert.equal(await redis.get(key('fixture-future')), null); assert.equal(Number(await redis.zScore(DUE, 'fixture-future')), future);
    console.log('PASS future work is not refreshed or rescheduled');

    held = await pause();
    const saved = `${names.ledger}_fixture_saved`, badSource = 'fixture_bad_ledger';
    await db.collection(names.ledger).rename(saved);
    await db.collection(badSource).insertOne({ followed_id: 'fixture-failure', invalidFixtureDate: 'not-a-date' });
    await db.createCollection(names.ledger, { viewOn: badSource, pipeline: [{ $set: { followed_at: { $dateFromString: { dateString: '$invalidFixtureDate' } } } }] });
    const old = JSON.stringify({ calculatedAt: 123, attackThreshold: 777, fixture: true });
    await redis.set(key('fixture-failure'), old, { EX: 600 });
    const failureAt = Date.now(); await queue('fixture-failure'); resume(held);
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.at >= failureAt && !row.frame.success), 'real Mongo aggregate failure');
    const retry = Number(await redis.zScore(DUE, 'fixture-failure'));
    assert(retry >= failureAt + 60000 && retry <= Date.now() + 60000, 'failure preserves sixty-second retry receipt');
    assert.equal(await redis.get(key('fixture-failure')), old, 'Mongo failure preserves old cache');
    assert.equal((await currentNative()).pid, held.pid, 'tick query failure stays inside child');
    held = await pause(); await db.collection(names.ledger).drop(); await db.collection(saved).rename(names.ledger);
    await queue('fixture-failure'); resume(held);
    await compare('fixture-failure', await refreshed('fixture-failure', 123));
    console.log('PASS real Mongo aggregate error retains old cache and 60-second retry, then recovers without child restart');

    held = await pause(); await redis.del(DUE); await redis.set(DUE, 'fixture-wrongtype');
    const wrongAt = Date.now(); resume(held);
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.at >= wrongAt && !row.frame.success), 'Redis wrongtype queue failure');
    assert.equal((await currentNative()).pid, held.pid);
    held = await pause(); await redis.del(DUE); await queue('fixture-after-redis'); resume(held);
    await refreshed('fixture-after-redis');
    console.log('PASS real Redis queue failure stays bounded and recovers');

    const killed = await pause(); stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'native-only replacement');
    await assertNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    await queue('fixture-after-restart'); await refreshed('fixture-after-restart');
    console.log('PASS native restart replaces only failed baseline child and replacement refreshes successfully');
    await waitFor(telemetry, 'actual baseline metrics in analytics-valid Redis envelopes', 35000);
    console.log('PASS real RSS/CPU/batch/idle/failure/error/restart telemetry reaches analytics-valid Redis envelopes');

    const child = spawn(process.execPath, ['/app/dist/workers/cron.index.js'], { cwd: '/app',
        env: { ...process.env, FOLLOW_BASELINE_FIXTURE_SCOPE: 'shutdown' }, stdio: ['ignore', 'pipe', 'pipe'] });
    auxiliary.add(child);
    let output = ''; const capture = data => { output = (output + data).slice(-4000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.fixtureCompletion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    child.fixtureCompletion.catch(() => {});
    const owned = await waitFor(() => currentNative('shutdown'), 'auxiliary child startup');
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch'), 'auxiliary functional idle');
    child.kill('SIGTERM');
    const exit = await bounded(child.fixtureCompletion, 15000, 'graceful supervisor shutdown'); auxiliary.delete(child);
    assert.equal(exit.code, 0, output); assert.equal(exit.signal, null);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === owned.pid && row.code === 0 && row.signal === null), 'native graceful exit');
    await delay(1200); assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1);
    assert(await currentNative());
    console.log('PASS real auxiliary supervisor SIGTERM drains baseline and exits without restart');
} finally {
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of auxiliary) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...auxiliary].map(async child => {
        try { await bounded(child.fixtureCompletion, 5000, 'cleanup SIGTERM'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.fixtureCompletion.catch(() => {}), 2000, 'cleanup SIGKILL').catch(() => {}); }
    }));
    await bounded(mongoose.disconnect(), 5000, 'reference disconnect').catch(() => {});
    try { assert.match(databaseName, /^follow_baseline_fixture_[a-zA-Z0-9_]+$/); await db.dropDatabase(); }
    finally {
        await bounded(client.close(), 5000, 'client close').catch(() => {});
        try {
            if (redis.isOpen) redis.destroy();
            if (referenceRedis?.isOpen) referenceRedis.destroy();
        } finally {
            // Only this check's reference utilities started these resources; the
            // real supervisor runs in a separate process and keeps its telemetry.
            telemetryTesting.stop();
        }
    }
}
async function bounded(promise, timeout, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); })]); }
    finally { clearTimeout(timer); }
}
