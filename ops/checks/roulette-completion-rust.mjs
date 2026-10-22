// Stage native-cron-fixture.mjs beside cron-boot.mjs for dual-supervisor verification.
import { rustRegistry, assertSelectedNatives } from '/tmp/saas-fixtures/native-cron-fixture.mjs';
// Real cron/native candidate check. Stage cron-boot.mjs and the exact source
// dima-analytics/src/store.mjs as analytics-store.mjs with --fixtures.
// Use only saas-ops disposable mongo/redis dependencies and this check's test-env.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire('/app/package.json');
const { MongoClient, BSON, ObjectId, Binary, Decimal128, Long } = require('mongodb');
const { createClient } = require('redis');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.equal(process.env.DRAGONFLY_HOST, 'redis');
const databaseName = decodeURIComponent(uri.pathname.slice(1));
const dbPattern = /^roulette_completion_fixture_[a-zA-Z0-9_]+$/;
assert.match(databaseName, dbPattern);
assert([undefined, 'node'].includes(process.env.CRON_WORKER_RUNTIME));
assert.equal(process.env.ROULETTE_COMPLETION_RUNTIME, undefined, 'exercise actual native default');
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const redis = createClient({ url: 'redis://redis:6379', socket: { reconnectStrategy: false } });
redis.on('error', () => {});
const owned = new Set([databaseName]), stopped = new Set(), children = new Set(), proxies = new Set();
const deadline = Date.now() + 240000;
const envFile = `/tmp/roulette-completion-fixture-${process.pid}.env`;
const actual = client.db(databaseName);
function fixtureDatabase(label) {
    const name = `roulette_completion_fixture_${process.pid}_${label}`;
    assert.match(name, dbPattern); assert(Buffer.byteLength(name) <= 63);
    owned.add(name); return client.db(name);
}
const reference = fixtureDatabase('reference');
const referenceUri = new URL(uri); referenceUri.pathname = `/${reference.databaseName}`;
// The existing service owns its Mongoose connection. Give that connection only
// the independent reference database, before its first snapshot call.
process.env.MONGO_URI = referenceUri.href;
mongoose.set('autoIndex', false);
const domain = await import('/app/dist/roulette/model.js');
const { RouletteChannel, snapshot } = await import('/app/dist/roulette/service.js');
const { telemetryTesting } = await import('/app/dist/utils/observability/telemetry.js');
const collection = RouletteChannel.collection.name;
const binary = '/usr/local/bin/roulette_completion';
assert.equal(collection, 'roulette_channels');
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"), 'stage exact analytics store source');
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
const clone = value => BSON.deserialize(BSON.serialize(value));
function normalize(value) {
    const serialized = BSON.EJSON.serialize(value, { relaxed: false });
    function sorted(row) {
        if (Array.isArray(row)) return row.map(sorted);
        if (row && typeof row === 'object') return Object.fromEntries(Object.keys(row).sort().map(key => [key, sorted(row[key])]));
        return row;
    }
    return sorted(serialized);
}
async function bounded(promise, ms, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]); } finally { clearTimeout(timer); }
}
async function waitFor(check, label, ms = 15000) {
    const until = Math.min(deadline, Date.now() + ms);
    do { const value = await check(); if (value) return value; await delay(50); } while (Date.now() < until);
    throw new Error(`Timed out: ${label}`);
}
async function records(scope = 'main') {
    let value;
    try { value = await readFile('/tmp/saas-fixtures/roulette-spawns.jsonl', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return value.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !exited.has(row.pid)).at(-1);
}
async function pause() {
    const row = await waitFor(() => currentNative(), 'native available to pause');
    process.kill(row.pid, 'SIGSTOP'); stopped.add(row.pid);
    await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`, 'utf8')), 'native paused before seeding');
    return row;
}
function resume(row) { process.kill(row.pid, 'SIGCONT'); stopped.delete(row.pid); }
function launch(command, args, env, extra = {}) {
    assert(Date.now() < deadline, '240-second acceptance-suite deadline exceeded before launch');
    const child = spawn(command, args, { cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
    children.add(child);
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.completion = new Promise((resolve, reject) => {
        let exitedAt;
        child.once('error', reject); child.once('exit', () => { exitedAt = performance.now(); });
        child.once('close', (code, signal) => resolve({ code, signal, output, exitedAt }));
    });
    child.completion.catch(() => {});
    return child;
}
async function finished(child, ms = 15000) {
    const remaining = deadline - Date.now(); assert(remaining > 0, '240-second acceptance-suite deadline exceeded');
    const result = await bounded(child.completion, Math.min(ms, remaining), 'fixture child completion');
    children.delete(child); return result;
}
const nativeEnv = mongo => ({ MONGO_URI: mongo, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' });
async function once(db = actual, args = [], env = {}) {
    const selected = new URL(uri); selected.pathname = `/${db.databaseName}`;
    return finished(launch('/usr/local/bin/roulette_completion', ['--once', ...args], { ...nativeEnv(selected.href), ...env }, { uid: 65534, gid: 65534 }));
}
// This task-owned loopback proxy has one fixed upstream: the helper's isolated
// Mongo alias. It understands only uncompressed Mongo command frames and fails
// explicitly on any wire form it cannot inspect. Nothing is exposed on the host.
async function mongoHoldProxy(db, command) {
    assert.match(db.databaseName, dbPattern); assert(owned.has(db.databaseName));
    assert(['find', 'update'].includes(command));
    const sockets = new Set();
    let failure, held, released = false, closing = false, pingSeen = false;
    const parsed = [];
    const fail = error => {
        failure ||= error instanceof Error ? error : new Error(String(error));
        for (const socket of sockets) socket.destroy();
    };
    const server = createServer(downstream => {
        sockets.add(downstream);
        const upstream = createConnection({ host: 'mongo', port: 27017 });
        sockets.add(upstream);
        let pending = Buffer.alloc(0), blocked = false;
        const queued = [];
        let queuedBytes = 0;
        downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
        upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
        for (const socket of [downstream, upstream]) socket.on('error', error => { if (!closing) fail(error); });
        upstream.pipe(downstream);
        downstream.on('data', chunk => {
            try {
                pending = Buffer.concat([pending, chunk]);
                if (pending.length > 16 * 1024 * 1024) throw new Error('Mongo fixture proxy received oversized frame');
                while (pending.length >= 16) {
                    const length = pending.readInt32LE(0), opcode = pending.readInt32LE(12);
                    assert(length >= 21 && length <= 16 * 1024 * 1024, 'invalid Mongo fixture frame length');
                    if (pending.length < length) break;
                    const packet = Buffer.from(pending.subarray(0, length)); pending = pending.subarray(length);
                    let body, database;
                    if (opcode === 2013) { // OP_MSG: header, flags, kind-0 BSON command body.
                        const flags = packet.readUInt32LE(16);
                        assert.equal(flags & ~0x10003, 0, 'unsupported Mongo OP_MSG flags');
                        assert.equal(packet[20], 0, 'Mongo command must start with section kind 0');
                        const bodyLength = packet.readInt32LE(21), end = 21 + bodyLength;
                        assert(bodyLength >= 5 && end <= length - (flags & 1 ? 4 : 0), 'invalid Mongo command BSON boundary');
                        body = BSON.deserialize(packet.subarray(21, end)); database = body.$db;
                    } else if (opcode === 2004) { // A legacy initial hello is safe to forward after inspection.
                        const end = packet.indexOf(0, 20);
                        assert(end > 20 && end + 9 < length, 'invalid Mongo OP_QUERY handshake');
                        const namespace = packet.toString('utf8', 20, end);
                        assert.equal(namespace, 'admin.$cmd', 'OP_QUERY is allowed only for initial admin hello');
                        body = BSON.deserialize(packet.subarray(end + 9)); database = 'admin';
                        assert(['hello', 'isMaster', 'ismaster'].some(key => key in body), 'unsupported legacy Mongo command');
                    } else throw new Error(`Unsupported Mongo fixture opcode ${opcode}; compression must remain disabled`);
                    const name = Object.keys(body)[0];
                    assert(database === db.databaseName || database === 'admin', 'proxy command escaped owned fixture database');
                    if (database === 'admin') assert(['hello', 'isMaster', 'ismaster', 'ping', 'endSessions'].includes(name), 'unexpected Mongo admin command');
                    if (name === 'ping' && database === 'admin') pingSeen = true;
                    parsed.push({ name, database, body, at: performance.now() });
                    if (!released && !held && name === command && body[name] === collection && database === db.databaseName) {
                        assert.equal(opcode, 2013, 'held fixture operation must be uncompressed OP_MSG');
                        assert(pingSeen, 'Mongo utility must complete its initial admin ping before the held pass');
                        blocked = true;
                        held = { at: Date.now(), body, release: () => {
                            if (released) return;
                            released = true; blocked = false;
                            if (!upstream.destroyed) { upstream.write(packet); for (const next of queued) upstream.write(next); }
                            queued.length = 0; queuedBytes = 0;
                        } };
                    } else if (blocked) {
                        queuedBytes += packet.length;
                        assert(queuedBytes <= 16 * 1024 * 1024, 'Mongo fixture hold queue exceeded bound');
                        queued.push(packet);
                    } else upstream.write(packet);
                }
            } catch (error) { fail(error); }
        });
    });
    server.on('error', fail);
    const proxy = {
        check() { if (failure) throw failure; },
        async held() { return waitFor(() => { proxy.check(); return held; }, `proxy holds actual Mongo ${command}`); },
        release() { proxy.check(); assert(held, 'selected command must be held before release'); held.release(); },
        parsed,
        async close() {
            if (closing) return;
            closing = true;
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), 3000, 'close owned Mongo proxy');
            proxies.delete(proxy);
        },
    };
    proxies.add(proxy);
    await bounded(new Promise((resolve, reject) => {
        server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    }), 3000, 'listen on isolated loopback Mongo proxy');
    const address = server.address(); assert(address && typeof address === 'object' && address.address === '127.0.0.1');
    proxy.uri = `mongodb://127.0.0.1:${address.port}/${db.databaseName}?directConnection=true`;
    return proxy;
}
function batchFrames(output) {
    return output.split('\n').filter(line => line.startsWith('roulette_completion:'))
        .map(line => JSON.parse(line.slice('roulette_completion:'.length)));
}

// Use stdout completion timestamps and remove the next pass's measured work.
// Each boundary is checked independently: aggregate throughput can hide sleeps.
function observeBatches(child) {
    const rows = []; let pending = '', failure;
    child.stdout.on('data', chunk => {
        try {
            pending += chunk; assert(pending.length <= 32768, 'continuous metadata buffer is bounded');
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) if (line.startsWith('roulette_completion:')) {
                const [frame] = batchFrames(line);
                assert.deepEqual(Object.keys(frame).sort(), ['durationMs', 'event', 'events', 'success']);
                assert.equal(frame.event, 'batch'); assert.equal(typeof frame.success, 'boolean');
                assert(Number.isInteger(frame.events) && frame.events >= 0 && frame.events <= 100);
                assert(Number.isFinite(frame.durationMs) && frame.durationMs >= 0);
                if (!frame.success) assert.equal(frame.events, 0);
                assert(rows.length < 100, 'continuous fixture cannot spin unboundedly');
                rows.push({ ...frame, at: performance.now() });
            }
        } catch (error) { failure ||= error; }
    });
    return { rows, check() { if (failure) throw failure; } };
}
const waitResidual = (before, after) => after.at - before.at - after.durationMs;
function assertReadyTransitions(rows, label) {
    for (let i = 1; i < rows.length; i++) assert(waitResidual(rows[i - 1], rows[i]) < 700,
        `${label} ready transition ${i} introduced ${Math.round(waitResidual(rows[i - 1], rows[i]))}ms residual wait`);
}
function assertPaced(before, after, label) {
    const residual = waitResidual(before, after);
    assert(residual >= 800, `${label} lost its one-second wait (${Math.round(residual)}ms residual)`);
}
function verifySchedulingAssertions() {
    const synthetic = waits => waits.reduce((rows, wait) => {
        const durationMs = 2100; rows.push({ at: rows.at(-1).at + durationMs + wait, durationMs }); return rows;
    }, [{ at: 100, durationMs: 5000 }]);
    assertReadyTransitions(synthetic([0, 50, 100]), 'ready control');
    assert.throws(() => assertReadyTransitions(synthetic([0, 0, 1000]), 'full-only control'), /ready transition 3 introduced 1000ms/);
    assert.throws(() => assertReadyTransitions(synthetic([0, 1000, 0]), 'sleep control'), /ready transition 2 introduced 1000ms/);
    assert.throws(() => assertReadyTransitions(synthetic([700]), 'threshold control'), /introduced 700ms/);
    const paced = synthetic([1000]); assertPaced(...paced, 'paced control');
    assert.throws(() => assertPaced(...synthetic([0]), 'spin control'), /lost its one-second wait/);
}
async function stopContinuous(child, observation) {
    assert(child.kill('SIGTERM')); const result = await finished(child, 7000);
    observation.check(); assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); return result;
}
const fixtureNow = Date.now();
function fixture(id, { action = 'keep', copies = 3, hide = null, ...options } = {}) {
    const state = domain.emptyState();
    const roulette = domain.create({ name: 'Fixture', alias: 'fixture', settings: { winnerAction: action } });
    const item = domain.add(roulette, { label: 'Frozen winner', multiplier: copies, weight: 7,
        action: '$(never_execute_roulette_fixture)' });
    domain.add(roulette, { label: 'Other', multiplier: 2, weight: 1 });
    state.roulettes.push(roulette); state.activeId = roulette.id;
    const draw = domain.start(state, roulette, fixtureNow - 20000, () => 0);
    // Persisted legacy zero values are accepted by settle, although current UI
    // validation permits only positive hide delays.
    draw.hideAfterSeconds = hide;
    if (options.future) { draw.startedAt += 3600000; draw.endsAt += 3600000; }
    if (options.edited) { domain.updateItem(roulette, item.id, { label: 'Edited live item', multiplier: 5, weight: 11 }); }
    if (options.deletedItem) domain.remove(roulette, item.id);
    if (options.deletedRoulette) state.roulettes = [];
    if (options.deletedCopy) { item.copies.shift(); item.multiplier = item.copies.length; roulette.order.shift(); }
    if (options.history) state.history = Array.from({ length: 100 }, (_, n) => ({ ...draw, id: `old-${n}`, slots: undefined, completedAt: draw.endsAt - n - 1 })).map(({ slots, ...entry }) => entry);
    if (options.hideOnly) { domain.settle(state, fixtureNow); state.visible = true; state.hideAt = fixtureNow - 1000; }
    if (options.noDraw) { state.draw = null; state.visible = true; state.hideAt = fixtureNow - 1000; }
    const dueAt = state.draw?.completedAt === null ? state.draw.endsAt : state.hideAt;
    const doc = new RouletteChannel({ _id: id, revision: 8, state, dueAt,
        tokenHash: 'fixture-token-hash', overlayToken: { iv: 'fixture-iv', content: 'fixture-ciphertext' },
        actions: [{ drawId: draw.id, rouletteId: roulette.id, itemId: item.id, label: 'Queued script',
            source: '$(never_execute_roulette_fixture)', dueAt: draw.endsAt, status: 'pending', actor: { userId: 'fixture-actor', userLogin: 'fixture', userDisplayName: 'Fixture' } }],
        actionDueAt: draw.endsAt, receipts: [{ key: 'fixture-key', fingerprint: 'fixture-fingerprint', result: 'fixture-result', at: fixtureNow }],
    }).toObject();
    // Mixed state and raw document fields are deliberately outside TS interfaces.
    const opaque = { nested: { date: new Date(123), oid: new ObjectId(), decimal: Decimal128.fromString('123.450'), binary: new Binary(Buffer.from([0, 1, 255])) } };
    doc.unrelated = clone(opaque); doc.state.opaque = clone(opaque);
    if (doc.state.draw) { doc.state.draw.opaque = clone(opaque); doc.state.draw.winner.opaque = clone(opaque); }
    if (doc.state.roulettes[0]) {
        doc.state.roulettes[0].opaque = clone(opaque);
        doc.state.roulettes[0].settings.opaque = clone(opaque);
        for (const existing of doc.state.roulettes[0].items) existing.opaque = clone(opaque);
    }
    if (options.noDraw === 'missing') delete doc.state.draw;
    if (options.missing) for (const key of ['actions', 'actionDueAt', 'receipts', 'tokenHash', 'overlayToken']) delete doc[key];
    return doc;
}
async function seed(db, docs) { await db.collection(collection).insertMany(docs.map(clone)); }
async function read(db, id) { return db.collection(collection).findOne({ _id: id }); }
async function completed(id) { return waitFor(async () => { const doc = await read(actual, id); return doc?.revision > 8 ? doc : null; }, `completed ${id}`); }
async function compare(doc) {
    const original = await read(reference, doc._id), expected = clone(original);
    const changed = domain.settle(expected.state, fixtureNow);
    if (changed) { expected.revision++; expected.dueAt = expected.state.draw?.completedAt === null ? expected.state.draw.endsAt : expected.state.hideAt; }
    // Independent real Mongoose snapshot must agree with the domain oracle and
    // native result for every persisted field, including optional absent fields.
    await snapshot(doc._id);
    const persisted = await read(reference, doc._id);
    assert.deepEqual(normalize(persisted), normalize(expected), `TS domain/snapshot agreement ${doc._id}`);
    assert.deepEqual(normalize(doc), normalize(persisted), `whole BSON persisted parity ${doc._id}`);
    for (const key of ['actions', 'actionDueAt', 'receipts', 'tokenHash', 'overlayToken', 'unrelated'])
        assert.deepEqual(normalize(doc[key]), normalize(original[key]), `completion preserves ${key}`);
}
async function assertNative(root) {
    const rows = await records(), exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    const alive = rows.filter(row => row.event === 'spawn' && row.native && row.supervisor === root && !exited.has(row.pid));
    assert.equal(alive.length, 1); const row = alive[0];
    assert.equal(row.command, '/usr/local/bin/roulette_completion');
    assert.equal(row.uid, 65534); assert.equal(row.gid, 65534);
    assert.deepEqual(row.envKeys.filter(key => !['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key)), []);
    assert(row.envKeys.includes('MONGO_URI')); assert(!row.envKeys.includes('NODE_OPTIONS'));
    const status = await readFile(`/proc/${row.pid}/status`, 'utf8');
    assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
    assert.match(status, /^Gid:\s+65534\s+65534\s+65534\s+65534$/m);
    assert(Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) > 0);
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
        let cmdline; try { cmdline = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
        assert(!cmdline.split('\0').some(arg => arg.endsWith('/roulette.worker.js')), 'legacy roulette child must not run');
    }
    for (const record of rows.filter(row => row.event === 'batch')) {
        const frame = record.frame;
        assert.equal(frame.event, 'batch'); assert(Number.isInteger(frame.events) && frame.events >= 0 && frame.events <= 100);
        assert.equal(typeof frame.success, 'boolean'); assert(Number.isFinite(frame.durationMs) && frame.durationMs >= 0);
    }
}
async function telemetry() {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse);
    for (const batch of batches) validateBatch(batch);
    const metrics = batches.flatMap(batch => batch.metrics.map(row => ({ ...row, service: batch.service })))
        .filter(row => row.name.startsWith('roulette_completion_rust.'));
    const allowed = ['rss_bytes', 'cpu_cores', 'batch_channels', 'project_batch', 'errors', 'restarts'];
    for (const row of metrics) {
        assert(allowed.includes(row.name.slice('roulette_completion_rust.'.length)));
        assert.equal(row.service, 'cron'); assert.equal(row.channel, '');
    }
    const has = (name, check = () => true) => metrics.some(row => row.name === `roulette_completion_rust.${name}` && check(row));
    return has('rss_bytes', row => row.kind === 'runtime' && row.max > 0)
        && has('cpu_cores', row => row.kind === 'runtime')
        && has('batch_channels', row => row.kind === 'worker' && row.sum > 0)
        && has('project_batch', row => row.kind === 'queue_run' && row.outcome === 'ok')
        && has('project_batch', row => row.kind === 'queue_run' && row.outcome === 'error')
        && has('errors', row => row.sum > 0) && has('restarts', row => row.sum > 0);
}

try {
    verifySchedulingAssertions();
    await client.connect(); await redis.connect();
    const native = await waitFor(() => currentNative(), 'actual default native startup'), root = native.supervisor;
    assertSelectedNatives(await records(), ['roulette-completion']);
    assert.equal(rustRegistry().find(worker => worker.name === 'roulette-completion').binary, '/usr/local/bin/roulette_completion');
    await assertNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    for (const worker of ['roulette-actions', 'domain-events', 'follow-ledger']) assert(unrelated.includes(worker));
    const idle = await waitFor(async () => { const rows = (await records()).filter(row => row.event === 'batch' && row.frame.success && row.frame.events === 0); return rows.length >= 3 ? rows.slice(-3) : null; }, 'fixed one-second idle polls');
    for (let i = 1; i < idle.length; i++) {
        assertPaced({ ...idle[i - 1].frame, at: idle[i - 1].at }, { ...idle[i].frame, at: idle[i].at }, 'initial idle roulette poll');
        assert(idle[i].at - idle[i - 1].at < 2400, 'fixed 1s polling without backoff');
    }
    console.log('PASS actual default native selection, one isolated unprivileged child, strict environment, and fixed one-second polling');
    let paused = await pause();
    for (const db of [actual, reference]) for (const [keys, options] of RouletteChannel.schema.indexes()) await db.collection(collection).createIndex(keys, options);
    const cases = [
        fixture('keep'), fixture('remove-item', { action: 'remove-item' }),
        fixture('remove-copy', { action: 'remove-copy', edited: true }),
        fixture('last-copy', { action: 'remove-copy', copies: 1 }),
        fixture('deleted-winner', { action: 'remove-item', deletedItem: true }),
        fixture('deleted-copy', { action: 'remove-copy', deletedCopy: true }),
        fixture('deleted-roulette', { action: 'remove-copy', deletedRoulette: true }),
        fixture('history100', { history: true }), fixture('hide-future', { hide: 3600 }),
        fixture('hide-immediate', { hide: 0 }), fixture('hide-only', { hideOnly: true }),
        fixture('hide-elapsed', { hide: 1 }), fixture('hide-no-draw', { noDraw: true }), fixture('hide-absent-draw', { noDraw: 'missing' }),
        fixture('missing-optionals', { missing: true }),
        fixture('future', { future: true }),
    ];
    await seed(actual, cases); await seed(reference, cases);
    // Write raw int64 values directly: clone()/normal driver reads promote the
    // inclusive +/-2^53 boundaries to JS numbers and would mask BSON type drift.
    const rawLongs = {
        'state.opaque.plusBoundary': Long.fromString('9007199254740992'),
        'state.opaque.minusBoundary': Long.fromString('-9007199254740992'),
        'state.opaque.unsafePlus': Long.fromString('9007199254740993'),
        'state.opaque.unsafeMinus': Long.fromString('-9007199254740993'),
        'state.opaque.small': Long.fromString('9'),
    };
    for (const db of [actual, reference])
        await db.collection(collection).updateOne({ _id: 'keep' }, { $set: rawLongs });
    resume(paused);
    await waitFor(async () => await actual.collection(collection).countDocuments({ _id: { $ne: 'future' }, revision: 9 }) === cases.length - 1, 'all parity cases settled');
    paused = await pause();
    for (const doc of await actual.collection(collection).find().toArray()) await compare(doc);
    const expectedTypes = { plusBoundary: 'double', minusBoundary: 'double', unsafePlus: 'long', unsafeMinus: 'long', small: 'int' };
    const typeProjection = Object.fromEntries(Object.keys(expectedTypes).map(key => [key, { $type: `$state.opaque.${key}` }]));
    const persistedTypes = async db => (await db.collection(collection).aggregate([
        { $match: { _id: 'keep' } }, { $project: { _id: 0, ...typeProjection } },
    ]).toArray())[0];
    assert.deepEqual(await persistedTypes(reference), expectedTypes, 'existing TypeScript snapshot BSON promotion contract');
    assert.deepEqual(await persistedTypes(actual), expectedTypes, 'native persisted BSON types must match TypeScript at inclusive +/-2^53 boundaries');
    console.log('PASS raw Mongo BSON types: +/-2^53 become doubles, unsafe adjacent int64s stay long, and int64 9 becomes int');
    assert.equal((await read(actual, 'history100')).state.history.length, 100);
    assert.equal((await read(actual, 'hide-immediate')).state.visible, false);
    assert.equal((await read(actual, 'hide-future')).state.visible, true);
    assert.equal((await read(actual, 'keep')).state.hideAt, null);
    assert.deepEqual(normalize(await read(actual, 'future')), normalize(cases.at(-1)));
    const settled = normalize(await actual.collection(collection).find().sort({ _id: 1 }).toArray());
    const before = (await records()).filter(row => row.event === 'batch').length;
    resume(paused);
    await waitFor(async () => (await records()).filter(row => row.event === 'batch').length >= before + 3, 'repeat polls');
    paused = await pause();
    assert.deepEqual(normalize(await actual.collection(collection).find().sort({ _id: 1 }).toArray()), settled);
    console.log('PASS full TypeScript domain/Mongoose persisted BSON parity: removal variants, frozen draw, history100, hide deadlines, defaults, untouched future rows and repeat-poll idempotency');

    // Real Rust and TS connections race the same revision CAS. These fixtures
    // are never eligible for action execution: all other workers stay inert.
    const races = Array.from({ length: 16 }, (_, n) => fixture(`race-${n}`, { action: 'remove-copy' }));
    await seed(actual, races);
    const snapshotScript = `import mongoose from 'mongoose'; import {snapshot} from '/app/dist/roulette/service.js';
        try { for (let i=0;i<3;i++) await Promise.all(JSON.parse(process.argv[1]).map(id=>snapshot(id))); }
        finally { await mongoose.disconnect(); }`;
    const racer = launch(process.execPath, ['--input-type=module', '-e', snapshotScript, JSON.stringify(races.map(doc => doc._id))],
        { ...process.env, MONGO_URI: uri.href, NODE_OPTIONS: '' });
    const runner = once();
    // Concurrent API-like revision/actions updates must survive any stale read.
    await Promise.all(races.map(doc => actual.collection(collection).updateOne({ _id: doc._id }, {
        $push: { actions: { drawId: `concurrent-${doc._id}`, status: 'pending', source: 'never execute', dueAt: fixtureNow } },
        $inc: { revision: 1 }, $set: { actionDueAt: fixtureNow, concurrentMarker: 'preserve' },
    })));
    const [rustResult, tsResult] = await Promise.all([runner, finished(racer)]);
    assert.equal(rustResult.code, 0, rustResult.output); assert.equal(tsResult.code, 0, tsResult.output);
    resume(paused); for (const doc of races) await completed(doc._id); paused = await pause();
    for (const original of races) {
        const doc = await read(actual, original._id), expected = clone(original);
        domain.settle(expected.state, fixtureNow);
        assert.deepEqual(normalize(doc.state), normalize(expected.state), 'race removes exactly one copy and appends one history entry');
        assert.equal(doc.revision, 10); assert.equal(doc.concurrentMarker, 'preserve');
        assert.equal(doc.actions.length, 2); assert.equal(doc.actions[1].drawId, `concurrent-${doc._id}`);
        for (const key of ['tokenHash', 'overlayToken', 'receipts', 'unrelated']) assert.deepEqual(normalize(doc[key]), normalize(original[key]));
    }
    console.log('PASS concurrent real Rust --once, TypeScript snapshots, and revision-changing action updates preserve CAS state without double removal or lost action writes');

    const batch = fixtureDatabase('batch');
    await seed(batch, Array.from({ length: 102 }, (_, n) => fixture(`batch-${n}`)));
    const firstBatch = await once(batch, ['--telemetry-json']);
    assert.equal(firstBatch.code, 0, firstBatch.output);
    assert.equal(await batch.collection(collection).countDocuments({ revision: 9 }), 100, 'one native pass processes at most 100 due channels');
    const firstFrame = firstBatch.output.split('\n').filter(line => line.startsWith('roulette_completion:')).map(line => JSON.parse(line.slice('roulette_completion:'.length)));
    assert.equal(firstFrame.length, 1); assert.equal(firstFrame[0].events, 100); assert.equal(firstFrame[0].success, true);
    const secondBatch = await once(batch); assert.equal(secondBatch.code, 0, secondBatch.output);
    assert.equal(await batch.collection(collection).countDocuments({ revision: 9 }), 102);
    console.log('PASS real 102-channel burst processes exactly 100 per --once pass and drains remaining deadlines on the next pass');

    const scheduling = fixtureDatabase('scheduling'), readyFuture = fixture('ready-future', { future: true });
    await seed(scheduling, [...Array.from({ length: 205 }, (_, n) => fixture(`ready-${n}`)), readyFuture]);
    const scheduleUri = new URL(uri); scheduleUri.pathname = `/${scheduling.databaseName}`;
    const schedule = launch(binary, ['--telemetry-json'], nativeEnv(scheduleUri.href), { uid: 65534, gid: 65534 });
    const scheduleFrames = observeBatches(schedule);
    await waitFor(() => { scheduleFrames.check(); return scheduleFrames.rows.length >= 5; }, 'continuous 205 due channels drain then future-only idle');
    assert.deepEqual(scheduleFrames.rows.slice(0, 5).map(row => [row.success, row.events]), [[true, 100], [true, 100], [true, 5], [true, 0], [true, 0]]);
    assertReadyTransitions(scheduleFrames.rows.slice(0, 3), 'roulette ready burst');
    assertPaced(scheduleFrames.rows[2], scheduleFrames.rows[3], 'partial roulette batch');
    assertPaced(scheduleFrames.rows[3], scheduleFrames.rows[4], 'future-only roulette batch');
    await stopContinuous(schedule, scheduleFrames);
    assert.equal(await scheduling.collection(collection).countDocuments({ revision: 9 }), 205);
    assert.deepEqual(normalize(await read(scheduling, 'ready-future')), normalize(readyFuture), 'future-only input remains untouched');
    console.log('PASS continuous 205 due roulette channels drain as bounded 100/100/5 batches without injected waits; partial tail and future-only idle keep default pacing');

    const cleanFull = fixtureDatabase('cleanfull'); await seed(cleanFull, Array.from({ length: 100 }, (_, n) => fixture(`clean-full-${n}`)));
    const cleanUri = new URL(uri); cleanUri.pathname = `/${cleanFull.databaseName}`;
    const cleanChild = launch(binary, ['--telemetry-json'], nativeEnv(cleanUri.href), { uid: 65534, gid: 65534 });
    const cleanFrames = observeBatches(cleanChild);
    await waitFor(() => { cleanFrames.check(); return cleanFrames.rows.length >= 2; }, 'clean full roulette batch has no ready remainder');
    assert.deepEqual(cleanFrames.rows.slice(0, 2).map(row => [row.success, row.events]), [[true, 100], [true, 0]]);
    assertPaced(cleanFrames.rows[0], cleanFrames.rows[1], 'full roulette batch with no due remainder');
    await stopContinuous(cleanChild, cleanFrames);
    assert.equal(await cleanFull.collection(collection).countDocuments({ revision: 9 }), 100);
    console.log('PASS clean full100 roulette batch waits when its fresh bounded due probe finds no ready work');

    // Hold the first real CAS after a raw100 query, then let another writer
    // settle all fetched rows. A zero changed count cannot hide 105 other due
    // rows; the fresh due probe must still continue immediately.
    const noops = fixtureDatabase('clearednoops');
    const noopSeeds = Array.from({ length: 205 }, (_, n) => fixture(`cleared-noop-${n}`, { action: 'remove-copy' }));
    await seed(noops, noopSeeds);
    const noopProxy = await mongoHoldProxy(noops, 'update');
    const noopChild = launch(binary, ['--telemetry-json'], nativeEnv(noopProxy.uri), { uid: 65534, gid: 65534 });
    const noopFrames = observeBatches(noopChild);
    await noopProxy.held();
    const fetchedQuery = noopProxy.parsed.find(row => row.name === 'find' && row.body.limit === 100);
    assert(fetchedQuery, 'hold occurs after bounded raw100 selection');
    const fetchedIds = noopSeeds.slice(0, 100).map(row => row._id);
    await noops.collection(collection).bulkWrite(noopSeeds.slice(0, 100).map(original => {
        const state = clone(original.state); assert(domain.settle(state, fixtureNow));
        return { updateOne: { filter: { _id: original._id, revision: 8 }, update: { $set: { state, dueAt: state.hideAt }, $inc: { revision: 1 } } } };
    }));
    noopProxy.release();
    await waitFor(() => { noopFrames.check(); noopProxy.check(); return noopFrames.rows.length >= 4; }, 'concurrently cleared raw100 no-ops continue remaining due work');
    assert.deepEqual(noopFrames.rows.slice(0, 4).map(row => [row.success, row.events]), [[true, 0], [true, 100], [true, 5], [true, 0]]);
    assertReadyTransitions(noopFrames.rows.slice(0, 3), 'zero-CAS raw100 roulette batch');
    assertPaced(noopFrames.rows[2], noopFrames.rows[3], 'partial roulette tail after concurrent no-ops');
    await stopContinuous(noopChild, noopFrames); noopProxy.check();
    const reloadsBeforeProbe = noopProxy.parsed.slice(noopProxy.parsed.indexOf(fetchedQuery) + 1).filter(row => row.name === 'find' && fetchedIds.includes(row.body.filter?._id));
    assert(new Set(reloadsBeforeProbe.map(row => row.body.filter._id)).size === 100, 'all selected raw100 rows reload even though no worker CAS succeeds');
    assert.equal(await noops.collection(collection).countDocuments({ revision: 9 }), 205);
    for (const row of await noops.collection(collection).find().toArray()) {
        assert.equal(row.state.history.length, 1); assert.equal(row.state.roulettes[0].items[0].multiplier, 2);
    }
    await noopProxy.close();
    console.log('PASS raw100 concurrent no-ops report zero successful CAS changes yet immediately drain other due channels, with exactly one history/removal per document');

    // A partial fetched batch can leave newly ready work: insert only after
    // its original due query is complete, while its first CAS is held.
    const partial = fixtureDatabase('partialready'), partialNoop = fixture('partial-concurrent-noop', { action: 'remove-copy' });
    await seed(partial, [fixture('partial-first', { action: 'remove-copy' }), partialNoop]);
    const partialProxy = await mongoHoldProxy(partial, 'update');
    const partialChild = launch(binary, ['--telemetry-json'], nativeEnv(partialProxy.uri), { uid: 65534, gid: 65534 });
    const partialFrames = observeBatches(partialChild);
    await partialProxy.held();
    const partialNoopState = clone(partialNoop.state); assert(domain.settle(partialNoopState, fixtureNow));
    await partial.collection(collection).updateOne({ _id: partialNoop._id, revision: 8 }, { $set: { state: partialNoopState, dueAt: partialNoopState.hideAt }, $inc: { revision: 1 } });
    await seed(partial, [fixture('partial-new-ready', { action: 'remove-copy' })]); partialProxy.release();
    await waitFor(() => { partialFrames.check(); partialProxy.check(); return partialFrames.rows.length >= 3; }, 'partial fetched roulette pass probes newly ready channel');
    assert.deepEqual(partialFrames.rows.slice(0, 3).map(row => [row.success, row.events]), [[true, 1], [true, 1], [true, 0]]);
    assertReadyTransitions(partialFrames.rows.slice(0, 2), 'partial fetched roulette batch');
    assertPaced(partialFrames.rows[1], partialFrames.rows[2], 'partial final roulette batch');
    await stopContinuous(partialChild, partialFrames); partialProxy.check(); await partialProxy.close();
    assert.equal(await partial.collection(collection).countDocuments({ revision: 9 }), 3);
    console.log('PASS a partial fetched roulette batch with a concurrent no-op probes newly due work and continues immediately, rejecting a full-batch-only scheduling policy');

    const persistent = fixtureDatabase('persistentnoop');
    const staleDues = Array.from({ length: 99 }, (_, n) => {
        const row = fixture(`persistent-stale-due-${n}`, { future: true }); row.dueAt = fixtureNow - 1000; return row;
    });
    await seed(persistent, [...staleDues, fixture('persistent-valid')]);
    const persistentUri = new URL(uri); persistentUri.pathname = `/${persistent.databaseName}`;
    const persistentChild = launch(binary, ['--telemetry-json'], nativeEnv(persistentUri.href), { uid: 65534, gid: 65534 });
    const persistentFrames = observeBatches(persistentChild);
    await waitFor(() => { persistentFrames.check(); return persistentFrames.rows.length >= 3; }, 'persistent due no-op cannot spin');
    assert.deepEqual(persistentFrames.rows.slice(0, 3).map(row => [row.success, row.events]), [[true, 1], [true, 0], [true, 0]]);
    assertPaced(persistentFrames.rows[0], persistentFrames.rows[1], 'mixed full persistent no-op');
    assertPaced(persistentFrames.rows[1], persistentFrames.rows[2], 'persistent stale due no-op');
    await stopContinuous(persistentChild, persistentFrames);
    for (const staleDue of staleDues) assert.deepEqual(normalize(await read(persistent, staleDue._id)), normalize(staleDue));
    assert.equal((await read(persistent, 'persistent-valid')).revision, 9);
    console.log('PASS a full raw100 mixed valid/persistent stale due batch and later no-op polls retain default pacing, preserve stale inputs and settle valid work once');

    const continuousFailure = fixtureDatabase('continuousfailure');
    const continuousFailureSeeds = Array.from({ length: 201 }, (_, n) => fixture(`continuous-failure-${n}`, { action: 'remove-copy' }));
    await seed(continuousFailure, continuousFailureSeeds);
    await continuousFailure.command({ collMod: collection, validator: { $or: [{ _id: { $ne: 'continuous-failure-100' } }, { revision: 8 }] }, validationLevel: 'strict', validationAction: 'error' });
    const continuousFailureUri = new URL(uri); continuousFailureUri.pathname = `/${continuousFailure.databaseName}`;
    const failureChild = launch(binary, ['--telemetry-json'], nativeEnv(continuousFailureUri.href), { uid: 65534, gid: 65534 });
    const failureFrames = observeBatches(failureChild);
    const continuousFailureExit = await finished(failureChild); failureFrames.check();
    assert.equal(continuousFailureExit.code, 1, continuousFailureExit.output); assert.equal(continuousFailureExit.signal, null);
    assert.deepEqual(failureFrames.rows.map(row => [row.success, row.events]), [[true, 100], [false, 0]]);
    assertReadyTransitions(failureFrames.rows, 'full roulette batch before storage failure');
    assert.equal(await continuousFailure.collection(collection).countDocuments({ revision: 9 }), 100);
    assert.deepEqual(normalize(await read(continuousFailure, 'continuous-failure-100')), normalize(continuousFailureSeeds[100]));
    await delay(1100);
    assert.equal(await continuousFailure.collection(collection).countDocuments({ revision: 9 }), 100, 'failed process cannot silently retry its ready backlog');
    console.log('PASS continuous full100 roulette batch proceeds to the next failed CAS without a sleep, then emits failed0 and exits nonzero with durable prior progress and untouched failed/backlog documents');

    const cli = fixtureDatabase('cli'); await seed(cli, [fixture('cli-due')]);
    const invalid = await finished(launch(binary, ['--definitely-invalid'], nativeEnv(uri.href)));
    assert.notEqual(invalid.code, 0);
    const missing = await finished(launch(binary, ['--once'], { PATH: process.env.PATH })); assert.notEqual(missing.code, 0);
    const noDb = new URL(uri); noDb.pathname = '/';
    const noDatabase = await finished(launch(binary, ['--once'], nativeEnv(noDb.href))); assert.notEqual(noDatabase.code, 0);
    const dry = await once(cli, ['--dry-run', '--env-file', '/does-not-exist']); assert.equal(dry.code, 0, dry.output);
    assert.equal((await read(cli, 'cli-due')).revision, 8, 'dry run performs no write or env-file access');
    const explicit = await finished(launch(binary, ['--once', '--database', cli.databaseName], nativeEnv(noDb.href)));
    assert.equal(explicit.code, 0, explicit.output); assert.equal((await read(cli, 'cli-due')).revision, 9);
    const envDb = fixtureDatabase('env'); await seed(envDb, [fixture('env-due')]);
    const envUri = new URL(uri); envUri.pathname = `/${envDb.databaseName}`;
    await writeFile(envFile, `MONGO_URI=${envUri.href}\n`, { mode: 0o644 });
    const envRun = await finished(launch(binary, ['--once', '--env-file', envFile], { PATH: process.env.PATH }));
    assert.equal(envRun.code, 0, envRun.output); assert.equal((await read(envDb, 'env-due')).revision, 9);
    const ignored = fixtureDatabase('ignored'); await seed(ignored, [fixture('ignored-due')]);
    const ignoredUri = new URL(uri); ignoredUri.pathname = `/${ignored.databaseName}`;
    await writeFile(envFile, `MONGO_URI=${ignoredUri.href}\n`);
    const precedence = await once(cli, ['--env-file', envFile]);
    assert.equal(precedence.code, 0, precedence.output); assert.equal((await read(ignored, 'ignored-due')).revision, 8);
    console.log('PASS CLI rejection, missing configuration/database, no-write dry run, explicit database, isolated env-file loading and environment precedence');

    // Pause immediately after an idle frame so the main child's 20-second pass
    // timer is not frozen inside an active operation while we hold another child.
    const idleBeforeHold = (await records()).filter(row => row.event === 'batch').length;
    resume(paused);
    await waitFor(async () => {
        const rows = (await records()).filter(row => row.event === 'batch');
        return rows.length > idleBeforeHold && rows.at(-1).frame.success && rows.at(-1).frame.events === 0;
    }, 'main native reaches idle before long isolated holds');
    paused = await pause();
    const watchdogDb = fixtureDatabase('watchdog'), watchdogSeed = fixture('held-find', { action: 'remove-copy' });
    await seed(watchdogDb, [watchdogSeed]);
    const watchdogProxy = await mongoHoldProxy(watchdogDb, 'find');
    const watchdogStarted = Date.now();
    const watchdog = launch(binary, ['--once', '--telemetry-json'], nativeEnv(watchdogProxy.uri), { uid: 65534, gid: 65534 });
    await watchdogProxy.held();
    const watchdogExit = await finished(watchdog, 28000); watchdogProxy.check();
    const watchdogElapsed = Date.now() - watchdogStarted;
    assert.notEqual(watchdogExit.code, 0, watchdogExit.output); assert.equal(watchdogExit.signal, null);
    assert(watchdogElapsed >= 18000 && watchdogElapsed < 28000, `actual watchdog elapsed ${watchdogElapsed}ms`);
    const failedFrames = batchFrames(watchdogExit.output);
    assert.equal(failedFrames.length, 1); assert.equal(failedFrames[0].success, false); assert.equal(failedFrames[0].events, 0);
    assert(failedFrames[0].durationMs >= 19000 && failedFrames[0].durationMs < 26000);
    assert.match(watchdogExit.output, /20-second watchdog/);
    assert.deepEqual(normalize(await read(watchdogDb, watchdogSeed._id)), normalize(watchdogSeed), 'watchdog leaves whole original document untouched');
    assert(!watchdogProxy.parsed.some(row => row.name === 'update'), 'held due query cannot partially write');
    await watchdogProxy.close();
    console.log(`PASS actual ${watchdogElapsed}ms native watchdog cancels held Mongo pass, emits failed zero-event frame, exits nonzero and preserves whole document`);

    const signalDb = fixtureDatabase('signalwrite'), signalSeed = fixture('held-write', { action: 'remove-copy' });
    const signalBacklog = Array.from({ length: 100 }, (_, n) => fixture(`signal-backlog-${n}`, { action: 'remove-copy' }));
    await seed(signalDb, [signalSeed, ...signalBacklog]);
    const signalProxy = await mongoHoldProxy(signalDb, 'update');
    // Normal polling mode is deliberate: without handling SIGTERM this child
    // would continue polling after the write and fail the bounded exit check.
    const signaled = launch(binary, ['--telemetry-json'], nativeEnv(signalProxy.uri), { uid: 65534, gid: 65534 });
    await signalProxy.held();
    assert.equal(signaled.kill('SIGTERM'), true);
    await delay(350); signalProxy.check();
    assert.equal(signaled.exitCode, null, 'SIGTERM must wait for the active CAS');
    assert.equal(signaled.signalCode, null); process.kill(signaled.pid, 0);
    assert.deepEqual(normalize(await read(signalDb, signalSeed._id)), normalize(signalSeed), 'held CAS has not reached Mongo yet');
    signalProxy.release();
    const signaledExit = await finished(signaled, 5000); signalProxy.check();
    assert.equal(signaledExit.code, 0, signaledExit.output); assert.equal(signaledExit.signal, null);
    const successFrames = batchFrames(signaledExit.output);
    assert.equal(successFrames.length, 1); assert.equal(successFrames[0].success, true); assert.equal(successFrames[0].events, 100);
    const signalExpected = clone(signalSeed); domain.settle(signalExpected.state, fixtureNow);
    signalExpected.revision++; signalExpected.dueAt = signalExpected.state.hideAt;
    const signalPersisted = await read(signalDb, signalSeed._id);
    assert.deepEqual(normalize(signalPersisted), normalize(signalExpected), 'SIGTERM completes exactly one CAS and preserves all unrelated fields');
    assert.equal(signalProxy.parsed.filter(row => row.name === 'update').length, 100);
    assert.equal(await signalDb.collection(collection).countDocuments({ revision: 9 }), 100, 'SIGTERM drains only its current bounded pass');
    assert.equal((await read(signalDb, signalBacklog.at(-1)._id)).revision, 8, 'ready backlog cannot start another pass after SIGTERM');
    await delay(1100);
    assert.deepEqual(normalize(await read(signalDb, signalSeed._id)), normalize(signalPersisted), 'exited child cannot restart or repeat winner removal');
    assert.equal(await signalDb.collection(collection).countDocuments({ revision: 9 }), 100);
    await signalProxy.close();
    console.log('PASS SIGTERM during a held actual Mongo CAS waits, completes its current bounded100 pass exactly once, and exits with ready backlog untouched');

    // Force stale-CAS retries rather than relying on process startup timing.
    // First prove a retry reloads both revision and wall clock after an action
    // writer advances revision while the auto-hide deadline crosses.
    const retryDb = fixtureDatabase('casclock'), retrySeed = fixture('cas-clock', { action: 'remove-copy', hide: 2 });
    retrySeed.state.draw.endsAt = Date.now() - 1000;
    retrySeed.state.draw.startedAt = retrySeed.state.draw.endsAt - 4000;
    retrySeed.dueAt = retrySeed.state.draw.endsAt;
    const hideDeadline = retrySeed.state.draw.endsAt + 2000;
    await seed(retryDb, [retrySeed]);
    const retryProxy = await mongoHoldProxy(retryDb, 'update');
    const retryChild = launch(binary, ['--once', '--telemetry-json'], nativeEnv(retryProxy.uri), { uid: 65534, gid: 65534 });
    const retryHeld = await retryProxy.held();
    assert(retryHeld.at < hideDeadline, 'test must hold first CAS before its future hide deadline');
    assert.equal((await read(retryDb, retrySeed._id)).revision, 8);
    const concurrentAction = { drawId: 'deterministic-concurrent-action', status: 'pending', source: 'never execute', dueAt: fixtureNow };
    const actionWrite = await retryDb.collection(collection).updateOne({ _id: retrySeed._id, revision: 8 }, {
        $push: { actions: concurrentAction }, $inc: { revision: 1 },
        $set: { actionDueAt: fixtureNow, concurrentMarker: 'preserve-across-stale-CAS' },
    });
    assert.equal(actionWrite.modifiedCount, 1);
    const retryExpected = await read(retryDb, retrySeed._id);
    await delay(Math.max(0, hideDeadline - Date.now()) + 150); retryProxy.check();
    assert(Date.now() > hideDeadline);
    retryProxy.release();
    const retryExit = await finished(retryChild, 5000); retryProxy.check();
    assert.equal(retryExit.code, 0, retryExit.output); assert.equal(retryExit.signal, null);
    const retryFrames = batchFrames(retryExit.output);
    assert.equal(retryFrames.length, 1); assert.equal(retryFrames[0].success, true); assert.equal(retryFrames[0].events, 1);
    assert(domain.settle(retryExpected.state, Date.now()));
    retryExpected.revision++; retryExpected.dueAt = retryExpected.state.hideAt;
    const retried = await read(retryDb, retrySeed._id);
    assert.deepEqual(normalize(retried), normalize(retryExpected), 'stale CAS retry uses fresh state/time and preserves concurrent actions');
    assert.equal(retried.revision, 10); assert.equal(retried.state.visible, false); assert.equal(retried.state.hideAt, null);
    assert.equal(retried.state.history.length, 1); assert.equal(retried.state.roulettes[0].items[0].multiplier, 2);
    assert.equal(retried.actions.at(-1).drawId, concurrentAction.drawId);
    assert.equal(retryProxy.parsed.filter(row => row.name === 'update').length, 2, 'one rejected stale CAS followed by exactly one successful fresh CAS');
    await retryProxy.close();
    console.log('PASS deterministic stale Rust CAS retries with fresh revision/time across auto-hide, preserves concurrent action writes, and completes once');

    // Then let the unchanged TypeScript snapshot win while Rust's first CAS is
    // held. Rust must reload the already-settled state and report zero work.
    const winnerDb = fixtureDatabase('casts'), winnerSeed = fixture('cas-ts-wins', { action: 'remove-copy' });
    await seed(winnerDb, [winnerSeed]);
    const winnerProxy = await mongoHoldProxy(winnerDb, 'update');
    const loser = launch(binary, ['--once', '--telemetry-json'], nativeEnv(winnerProxy.uri), { uid: 65534, gid: 65534 });
    await winnerProxy.held();
    assert.equal((await read(winnerDb, winnerSeed._id)).revision, 8);
    const winnerUri = new URL(uri); winnerUri.pathname = `/${winnerDb.databaseName}`;
    const tsWinner = launch(process.execPath, ['--input-type=module', '-e', snapshotScript, JSON.stringify([winnerSeed._id])], {
        ...process.env, MONGO_URI: winnerUri.href, NODE_OPTIONS: '',
    });
    const tsWinnerExit = await finished(tsWinner); assert.equal(tsWinnerExit.code, 0, tsWinnerExit.output);
    const won = await read(winnerDb, winnerSeed._id);
    assert.equal(won.revision, 9); assert.equal(won.state.history.length, 1); assert.equal(won.state.roulettes[0].items[0].multiplier, 2);
    winnerProxy.release();
    const loserExit = await finished(loser, 5000); winnerProxy.check();
    assert.equal(loserExit.code, 0, loserExit.output); assert.equal(loserExit.signal, null);
    const loserFrames = batchFrames(loserExit.output);
    assert.equal(loserFrames.length, 1); assert.equal(loserFrames[0].success, true); assert.equal(loserFrames[0].events, 0);
    assert.deepEqual(normalize(await read(winnerDb, winnerSeed._id)), normalize(won), 'Rust losing CAS cannot rewrite TypeScript winner or duplicate history/removal');
    assert.equal(winnerProxy.parsed.filter(row => row.name === 'update').length, 1, 'settled reload performs no second update');
    await winnerProxy.close();
    console.log('PASS deterministic TypeScript snapshot wins held Rust CAS; Rust reloads as zero-work without double history, removal or rewriting');

    // A collection validator causes a real storage failure before the atomic
    // CAS can persist. Parent must observe failure and restart only this child.
    const failureSeed = fixture('write-failure', { action: 'remove-copy' });
    await seed(actual, [failureSeed]);
    await actual.command({ collMod: collection, validator: { $or: [{ _id: { $ne: 'write-failure' } }, { revision: 8 }] }, validationLevel: 'strict', validationAction: 'error' });
    const failurePid = paused.pid; resume(paused);
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.pid === failurePid && row.frame.success === false), 'actual failed batch protocol');
    assert.deepEqual(normalize(await read(actual, 'write-failure')), normalize(failureSeed), 'failed CAS leaves whole original document intact');
    await actual.command({ collMod: collection, validator: {}, validationLevel: 'strict' });
    await waitFor(async () => { const row = await currentNative(); return row && row.pid !== failurePid; }, 'storage failure child restart');
    paused = await pause();
    resume(paused); const recovered = await completed('write-failure'); paused = await pause();
    assert.equal(recovered.revision, 9); assert.equal(recovered.state.history.length, 1);
    assert.equal(recovered.state.roulettes[0].items[0].multiplier, 2);
    console.log('PASS actual Mongo validator failure persists no partial removal, emits failure, restarts only roulette, and recovers safely');

    const killed = paused; stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'roulette-only SIGKILL restart');
    assert.equal(replacement.supervisor, root); await assertNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    await seed(actual, [fixture('after-restart')]); await completed('after-restart');
    await waitFor(telemetry, 'actual native runtime/batch/error/restart Redis metrics', 35000);
    console.log('PASS roulette-only SIGKILL recovery and real analytics-valid Redis runtime, batch, error and restart envelopes');

    const shutdown = fixtureDatabase('shutdown'), shutdownUri = new URL(uri); shutdownUri.pathname = `/${shutdown.databaseName}`;
    const child = launch(process.execPath, ['/app/dist/workers/cron.index.js'], {
        ...process.env, MONGO_URI: shutdownUri.href, ROULETTE_COMPLETION_FIXTURE_SCOPE: 'shutdown',
    });
    const ownedChild = await waitFor(() => currentNative('shutdown'), 'auxiliary supervisor native child');
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch' && row.frame.success), 'auxiliary functional poll');
    child.kill('SIGTERM'); const exit = await finished(child);
    assert.equal(exit.code, 0, exit.output); assert.equal(exit.signal, null);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === ownedChild.pid && row.code === 0 && row.signal === null), 'graceful native exit');
    await delay(1200);
    assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1);
    assert(await currentNative());
    console.log('PASS actual auxiliary supervisor SIGTERM gracefully stops native roulette without restart');
} finally {
    // The real TS snapshot starts its own telemetry Redis connection. Close
    // this check process's connection; the supervised cron remains separate.
    telemetryTesting.stop();
    await Promise.allSettled([...proxies].map(proxy => proxy.close()));
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...children].map(async child => {
        try { await bounded(child.completion, 5000, 'cleanup SIGTERM'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.completion.catch(() => {}), 2000, 'cleanup SIGKILL').catch(() => {}); }
    }));
    await bounded(mongoose.disconnect(), 5000, 'reference disconnect').catch(() => {});
    await unlink(envFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    try { for (const name of owned) { assert.match(name, dbPattern); await client.db(name).dropDatabase(); } }
    finally { await bounded(client.close(), 5000, 'client close').catch(() => {}); if (redis.isOpen) redis.destroy(); }
}
