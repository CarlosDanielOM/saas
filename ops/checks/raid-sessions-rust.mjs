// Exact cron candidate only: saas-ops --dependency mongo --dependency redis.
// Stage every raid-sessions-rust-fixtures file; no production settings or APIs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, unlink, chmod, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire('/app/package.json');
const { MongoClient, BSON, ObjectId } = require('mongodb');
const { createClient } = require('redis');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.equal(uri.port, '27017');
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
assert.equal(process.env.RAID_SESSIONS_RUNTIME, undefined, 'native default must be exercised');
const dbPattern = /^raid_sessions_fixture_[a-zA-Z0-9_]+$/;
const databaseName = decodeURIComponent(uri.pathname.slice(1)); assert.match(databaseName, dbPattern);
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const redis = createClient({ url: 'redis://redis:6379', socket: { reconnectStrategy: false } }); redis.on('error', () => {});
const owned = new Set([databaseName]), children = new Set(), stopped = new Set(), proxies = new Set(), files = new Set(), keys = new Set(), directories = new Set();
const deadline = Date.now() + 235000, binary = '/usr/local/bin/raid_sessions', protocol = 'raid_sessions:';
const now = Date.now(), HOUR = 3600000;
const actual = client.db(databaseName);
function fixtureDatabase(label) {
    const name = `raid_sessions_fixture_${process.pid}_${label}`;
    assert.match(name, dbPattern); assert(Buffer.byteLength(name) <= 63); owned.add(name); return client.db(name);
}
const referenceDb = fixtureDatabase('reference');
const { RaidSessionSchema: Sessions, RaidFollowerSchema: Followers, RaidModerationRequestSchema: Requests } = await import('/app/dist/schemas/raid_session.schema.js');
const { FollowDefenseActionSchema: Actions, FollowDefenseControlSchema: Controls } = await import('/app/dist/schemas/follow_defense_action.schema.js');
const { FollowDefenseSettingsSchema: Settings } = await import('/app/dist/schemas/follow_defense_settings.schema.js');
const { DomainEventSchema: Events } = await import('/app/dist/schemas/domain_event.schema.js');
const models = { sessions: Sessions, followers: Followers, requests: Requests, actions: Actions, controls: Controls, settings: Settings, events: Events };
const names = Object.fromEntries(Object.entries(models).map(([key, model]) => [key, model.collection.name]));
const coll = (db, name) => db.collection(names[name]);
const id = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const channel = label => `fixture-${label}`;
function nativeEnv(db = actual, extra = {}) {
    assert(owned.has(db.databaseName)); const selected = new URL(uri); selected.pathname = `/${db.databaseName}`;
    return { MONGO_URI: selected.href, DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', ...extra };
}
async function bounded(promise, ms, label) {
    let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
    finally { clearTimeout(timer); }
}
async function waitFor(check, label, ms = 15000) {
    const end = Math.min(deadline, Date.now() + ms);
    do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < end);
    throw new Error(`Timed out: ${label}`);
}
function launch(command, args, env, extra = {}) {
    assert(Date.now() < deadline, '235-second acceptance-suite deadline exceeded before child launch');
    const child = spawn(command, args, { cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'], ...extra }); children.add(child);
    child.output = ''; const capture = chunk => { child.output = (child.output + chunk).slice(-30000); };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, output: child.output, exitedAt: performance.now() })); });
    child.completion.catch(() => {}); return child;
}
async function finished(child, ms = 25000) {
    const remaining = deadline - Date.now(); assert(remaining > 0, '235-second acceptance-suite deadline exceeded while awaiting child');
    const result = await bounded(child.completion, Math.min(ms, remaining), 'fixture process within acceptance-suite deadline'); children.delete(child); return result;
}
function frames(output) {
    return output.split('\n').filter(line => line.startsWith(protocol)).map(line => {
        const frame = JSON.parse(line.slice(protocol.length));
        assert.deepEqual(Object.keys(frame).sort(), ['durationMs', 'event', 'events', 'success']);
        assert.equal(frame.event, 'batch'); assert.equal(typeof frame.success, 'boolean');
        assert(Number.isInteger(frame.events) && frame.events >= 0 && frame.events <= 401);
        assert(Number.isFinite(frame.durationMs) && frame.durationMs >= 0);
        if (!frame.success) assert.equal(frame.events, 0, 'failed ticks cannot advertise completed work');
        return frame;
    });
}
// Capture completion times at stdout receipt; subtract each next tick's own
// duration so Mongo work and deliberate command barriers do not count as sleeps.
function observeBatches(child) {
    const rows = []; let pending = '', failure;
    child.stdout.on('data', chunk => {
        try {
            pending += chunk; assert(pending.length <= 32768, 'continuous metadata buffer is bounded');
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) if (line.startsWith(protocol)) {
                const [frame] = frames(line); assert(rows.length < 100, 'continuous fixture cannot spin unboundedly');
                rows.push({ ...frame, at: performance.now() });
            }
        } catch (error) { failure ||= error; }
    });
    return { rows, check() { if (failure) throw failure; } };
}
const waitResidual = (before, after) => after.at - before.at - after.durationMs;
function assertReadyTransitions(rows, label) {
    const residuals = rows.slice(1).map((row, index) => waitResidual(rows[index], row));
    for (const [index, residual] of residuals.entries())
        assert(residual < 700, `${label} ready transition ${index + 1} introduced ${Math.round(residual)}ms residual wait`);
    return residuals.reduce((sum, residual) => sum + residual, 0);
}
// No-network controls make the scheduling assertion's regression sensitivity
// reviewable: full-batches-only draining formerly passed the aggregate guard.
function verifyReadyTransitionAssertions() {
    const synthetic = waits => waits.reduce((rows, wait, index) => {
        const durationMs = 2000 + index * 100;
        rows.push({ at: rows.at(-1).at + durationMs + wait, durationMs }); return rows;
    }, [{ at: 100, durationMs: 5000 }]);
    assert.equal(assertReadyTransitions(synthetic([0, 50, 100, 0, 100, 0, 50]), 'quick control'), 300);
    const fullOnly = synthetic([0, 0, 1000, 1000, 0, 1000, 1000]);
    assert.equal(fullOnly.slice(1).reduce((sum, row, index) => sum + waitResidual(fullOnly[index], row), 0), 4000);
    assert.throws(() => assertReadyTransitions(fullOnly, 'full-only control'), /ready transition 3 introduced 1000ms/);
    assert.throws(() => assertReadyTransitions(synthetic([699, 700]), 'threshold control'), /ready transition 2 introduced 700ms/);
}
async function stopContinuous(child, observation) {
    assert(child.kill('SIGTERM')); const result = await finished(child);
    observation.check(); assert.equal(result.code, 0); assert.equal(result.signal, null); return result;
}
async function once(db = actual, extra = {}, args = []) { return finished(launch(binary, ['--once', '--telemetry-json', ...args], nativeEnv(db, extra), { uid: 65534, gid: 65534 })); }
async function success(db = actual, extra = {}, args = []) {
    const result = await once(db, extra, args); assert.equal(result.code, 0, 'native once failed'); assert.equal(result.signal, null);
    const rows = frames(result.output); assert.equal(rows.length, 1); assert.equal(rows[0].success, true); return rows[0];
}
let sequence = 0;
async function reference(db, input) {
    const file = `/tmp/raid-sessions-fixture-${process.pid}-${++sequence}.json`; files.add(file); await writeFile(file, JSON.stringify(input));
    const result = await finished(launch(process.execPath, ['/tmp/saas-fixtures/reference.mjs', file], { ...process.env, ...nativeEnv(db), NODE_OPTIONS: '', OBSERVABILITY_DISABLED: 'true' }));
    assert.equal(result.code, 0, 'shared TypeScript reference failed');
    const line = result.output.split('\n').find(line => line.startsWith('RAID_SESSIONS_REFERENCE:')); assert(line); return JSON.parse(line.slice('RAID_SESSIONS_REFERENCE:'.length));
}
async function indexes(db) { for (const model of Object.values(models)) for (const [index, options] of model.schema.indexes()) await db.collection(model.collection.name).createIndex(index, options); }
function session(label, extra = {}) {
    return new Sessions({ _id: id('session', label), channelID: channel(label), eventID: label, raiderID: `raider-${label}`, startedAt: new Date(now - 60000),
        captureUntil: new Date(now + 240000), retentionHours: 72, expiresAt: new Date(now + 71 * HOUR), purgeAt: new Date(now + 72 * HOUR), backfillUntil: new Date(now), backfillDone: true, ...extra }).toObject();
}
function request(s, label = 'request', extra = {}) {
    return new Requests({ _id: id('request', s._id, label), channelID: s.channelID, sessionID: s._id, actorID: 'fixture-actor', requestedAt: new Date(now - 5000),
        expiresAt: new Date(now + HOUR), purgeAt: new Date(now + 7 * 24 * HOUR), ...extra }).toObject();
}
function follower(s, index, extra = {}) {
    return new Followers({ _id: id(s.channelID, `event-${index}`), channelID: s.channelID, sessionID: s._id, eventID: `event-${index}`, userID: String(index), login: `viewer${index}`, name: `Viewer${index}`,
        followedAt: new Date(now - 50000 + index), recordedAt: new Date(now - 10000), purgeAt: s.purgeAt, ...extra }).toObject();
}
async function seed(db, fixture) {
    for (const [name, rows] of Object.entries(fixture)) if (rows.length) {
        const prepared = name === 'events' ? rows.map(row => ({ sourceEventId: row.eventKey, topic: 'channel', schemaVersion: 1, metadata: {}, expiresAt: new Date(now + 7 * 24 * HOUR), ...row })) : rows;
        await coll(db, name).insertMany(BSON.deserialize(BSON.serialize({ rows: prepared })).rows);
    }
}
async function both(fixture) { await seed(actual, fixture); await seed(referenceDb, fixture); }
async function reset(...dbs) { for (const db of dbs.length ? dbs : [actual, referenceDb]) for (const name of Object.keys(models)) await coll(db, name).deleteMany({}); }
async function setState(s, req, extra = {}) {
    const key = `twitch:${s.channelID}:follow-defense:state`; keys.add(key);
    await redis.set(key, JSON.stringify({ mode: 'attack', channelID: s.channelID, raidSessionID: s._id, raidRequestID: req._id, expiresAt: Date.now() + 120000, ...extra }), { EX: 120 });
}
async function clearState() { const stateKeys = [...keys].filter(key => key.startsWith('twitch:')); if (stateKeys.length) await redis.del(stateKeys); for (const key of stateKeys) keys.delete(key); }
const variableDates = new Set(['recordedAt', 'createdAt', 'updatedAt', 'nextAttemptAt', 'purgeAt']);
function compareValues(a, b, field = '') {
    if (a instanceof Date || b instanceof Date) {
        assert(a instanceof Date && b instanceof Date, `BSON date parity: ${field}`);
        const tolerance = variableDates.has(field) ? 12000 : 0;
        assert(Math.abs(+a - +b) <= tolerance, `date value parity: ${field}`); return;
    }
    if (a?._bsontype || b?._bsontype) { assert.deepEqual(BSON.EJSON.serialize(a, { relaxed: false }), BSON.EJSON.serialize(b, { relaxed: false })); return; }
    if (Array.isArray(a) || Array.isArray(b)) { assert(Array.isArray(a) && Array.isArray(b)); assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) compareValues(a[i], b[i], field); return; }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `complete field/default parity: ${field}`);
        for (const key of Object.keys(a)) compareValues(a[key], b[key], key); return;
    }
    assert.deepEqual(a, b, `persisted parity: ${field}`);
}
async function parity(selected = ['sessions', 'followers', 'requests', 'actions', 'controls']) {
    for (const name of selected) {
        const a = await coll(actual, name).find().sort({ _id: 1 }).toArray(), b = await coll(referenceDb, name).find().sort({ _id: 1 }).toArray();
        compareValues(a, b, name);
        // Query Mongo's stored types rather than JS numbers, which promote Int32 and Double alike.
        const fields = [...new Set([...a, ...b].flatMap(Object.keys))].sort();
        // Mongo rejects an empty object sub-projection. Complete value parity
        // above already proved these two collections are both empty.
        if (!fields.length) { assert.equal(a.length, 0); assert.equal(b.length, 0); continue; }
        const types = db => coll(db, name).aggregate([{ $sort: { _id: 1 } }, { $project: { _id: 1, types: Object.fromEntries(fields.map(key => [key, { $type: `$${key}` }])) } }]).toArray();
        assert.deepEqual(await types(actual), await types(referenceDb), `raw BSON type parity: ${name}`);
    }
}
async function records(scope = 'main') {
    let text; try { text = await readFile('/tmp/saas-fixtures/raid-sessions-spawns.jsonl', 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !exited.has(row.pid)).at(-1);
}
async function pause(scope = 'main') {
    const prior = (await records(scope)).filter(row => row.event === 'batch').length;
    await waitFor(async () => (await records(scope)).filter(row => row.event === 'batch').length > prior, 'native tick boundary');
    const row = await currentNative(scope); process.kill(row.pid, 'SIGSTOP'); stopped.add(row.pid);
    await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`, 'utf8')), 'native paused'); return row;
}
async function assertNative(scope = 'main') {
    const row = await currentNative(scope); assert(row); assert.equal(row.command, binary); assert.equal(row.uid, 65534); assert.equal(row.gid, 65534);
    assert.deepEqual(row.args, ['--telemetry-json']);
    assert.deepEqual(row.envKeys.filter(key => !['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DRAGONFLY_HOST', 'DRAGONFLY_PORT'].includes(key)), []);
    const status = await readFile(`/proc/${row.pid}/status`, 'utf8'); assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
    assert.equal((await readFile(`/proc/${row.pid}/cmdline`, 'utf8')).split('\0')[0], binary); return row;
}

// Abrupt process::exit can reset a socket without FIN when unread data exists.
// Only the separately confirmed watchdog exit may classify that teardown; every
// normal proxy check remains strict, including a reset before the death window.
function assertWatchdogResetTiming(errors, exitedAt) {
    assert(Number.isFinite(exitedAt), 'confirmed native exit needs a monotonic timestamp');
    for (const error of errors) {
        assert.equal(error.kind, 'transport', 'watchdog cannot excuse parser/proxy failures');
        assert.equal(error.side, 'client', 'watchdog cannot excuse upstream failures');
        assert.equal(error.code, 'ECONNRESET', 'watchdog excuses only abrupt client resets');
        assert.equal(error.clientEof, false, 'FIN teardown follows the existing EOF/EPIPE rules');
        assert.equal(error.held, true); assert.equal(error.released, false);
        assert(Math.abs(error.at - exitedAt) <= 250, 'client reset must coincide within 250ms of confirmed hard exit');
    }
}
function verifyWatchdogResetClassification() {
    const reset = { kind: 'transport', side: 'client', code: 'ECONNRESET', clientEof: false, held: true, released: false, at: 1000 };
    assertWatchdogResetTiming([reset], 1001);
    for (const different of [
        { at: 0 }, { at: 2000 }, { side: 'upstream' }, { code: 'EPIPE' },
        { kind: 'proxy' }, { clientEof: true }, { held: false }, { released: true },
    ]) assert.throws(() => assertWatchdogResetTiming([{ ...reset, ...different }], 1001));
}
// Fixed alias upstream; parses actual uncompressed Mongo commands, holds exactly one.
async function mongoHoldProxy(db, predicate) {
    assert.match(db.databaseName, dbPattern); assert(owned.has(db.databaseName));
    const sockets = new Set();
    let failure, held, released = false, closing = false, pingSeen = false;
    const parsed = [], failures = [];
    const transport = { clientEofs: 0, upstreamEofs: 0, teardownEpipe: 0 };
    const fail = (error, detail = { kind: 'proxy' }) => {
        failures.push({ ...detail, at: performance.now(), held: Boolean(held), released });
        failure ||= error instanceof Error ? error : new Error(String(error));
        for (const socket of sockets) socket.destroy();
    };
    const server = createServer(downstream => {
        sockets.add(downstream);
        const upstream = createConnection({ host: 'mongo', port: 27017 });
        sockets.add(upstream);
        let pending = Buffer.alloc(0), blocked = false, clientEof = false;
        const queued = [];
        let queuedBytes = 0;
        const stopPair = () => {
            upstream.unpipe(downstream);
            upstream.destroy(); downstream.destroy();
        };
        // With allowHalfOpen=false, Node changes downstream.write to
        // writeAfterFIN at 'end'. Waiting for 'close' leaves a window in which
        // an in-flight Mongo response can be piped into an ended socket.
        downstream.on('end', () => { clientEof = true; transport.clientEofs++; stopPair(); });
        downstream.on('close', () => { sockets.delete(downstream); stopPair(); });
        upstream.on('end', () => {
            transport.upstreamEofs++;
            if (!closing && !clientEof) fail(new Error('Mongo fixture upstream EOF before client teardown'));
            stopPair();
        });
        upstream.on('close', () => { sockets.delete(upstream); stopPair(); });
        for (const [side, socket] of [['client', downstream], ['upstream', upstream]]) socket.on('error', error => {
            if (closing) return;
            // Only a write-after-FIN following an observed client EOF belongs
            // to normal child teardown. Pre-EOF EPIPE and all other errors
            // still fail the fixture; canceled Mongo requests are not released.
            if (clientEof && error.code === 'EPIPE') { transport.teardownEpipe++; return; }
            fail(new Error(`Mongo fixture ${side} transport failed (${error.code || 'unknown'}, clientEof=${clientEof})`, { cause: error }),
                { kind: 'transport', side, code: error.code, clientEof });
        });
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
                        let offset = end;
                        while (offset < length - (flags & 1 ? 4 : 0)) {
                            assert.equal(packet[offset++], 1, 'only BSON document sequences follow command body');
                            const sectionStart = offset, sectionSize = packet.readInt32LE(offset); offset += 4;
                            const identifierEnd = packet.indexOf(0, offset);
                            assert(identifierEnd > offset && identifierEnd < sectionStart + sectionSize);
                            const identifier = packet.toString('utf8', offset, identifierEnd); offset = identifierEnd + 1;
                            body[identifier] = [];
                            while (offset < sectionStart + sectionSize) {
                                const size = packet.readInt32LE(offset); assert(size >= 5 && offset + size <= sectionStart + sectionSize);
                                body[identifier].push(BSON.deserialize(packet.subarray(offset, offset + size))); offset += size;
                            }
                            assert.equal(offset, sectionStart + sectionSize);
                        }
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
                    if (!released && !held && database === db.databaseName && predicate(body)) {
                        assert.equal(opcode, 2013, 'held fixture operation must be uncompressed OP_MSG');
                        assert(pingSeen, 'Mongo utility must complete its initial admin ping before the held pass');
                        blocked = true;
                        held = { at: Date.now(), body, release: () => {
                            if (released) return;
                            assert(!clientEof && !upstream.destroyed && !upstream.writableEnded,
                                'cannot release held Mongo command after its client/upstream has ended');
                            released = true; blocked = false;
                            upstream.write(packet); for (const next of queued) upstream.write(next);
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
        checkConfirmedWatchdogExit(result, elapsed) {
            assert.equal(result.code, 1); assert.equal(result.signal, null);
            assert(elapsed >= 18000 && elapsed <= 25000, 'native exit must match the hard watchdog window');
            assert.equal(frames(result.output).length, 0);
            assert.match(result.output, /Raid session active work exceeded 20-second watchdog; durable work retained for recovery/);
            assert(held && !released, 'hard exit must leave the actual selected command unforwarded');
            assertWatchdogResetTiming(failures, result.exitedAt);
        },
        snapshot: () => ({ ...transport, held: Boolean(held), released, activeSockets: sockets.size, failures: failures.map(row => ({ ...row })) }),
        async held() { return waitFor(() => { proxy.check(); return held; }, 'proxy holds selected actual Mongo command'); },
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
const updates = body => body.findAndModify ? [{ q: body.query, u: body.update }] : body.update ? body.updates || [] : [];
const updatesCollection = (body, name) => body.update === names[name] || body.findAndModify === names[name];
const setsField = (body, name, field) => updatesCollection(body, name) && updates(body).some(update => field in (update.u?.$set || {}));
async function failOnce(db, extra = {}) {
    const result = await once(db, extra); assert.notEqual(result.code, 0); assert.equal(result.signal, null);
    const rows = frames(result.output); assert.equal(rows.length, 1); assert.equal(rows[0].success, false); assert.equal(rows[0].events, 0); return result;
}
let paused;
try {
    verifyReadyTransitionAssertions(); verifyWatchdogResetClassification();
    await client.connect(); await redis.connect(); await indexes(actual); await indexes(referenceDb);
    const unrelatedKey = 'raid-sessions-fixture:unrelated'; keys.add(unrelatedKey); await redis.set(unrelatedKey, 'preserve', { EX: 300 });
    const { WORKERS, resolveWorkerLaunch } = await import('/app/dist/workers/cron.index.js');
    const { NATIVE_WORKERS } = await import('/app/dist/utils/observability/native_worker_metrics.js');
    assert.equal(Object.keys(NATIVE_WORKERS).length, 6, 'natural sixth native worker');
    const definition = WORKERS.find(worker => worker.name === 'raid-sessions'); assert.equal(definition.kind, 'native');
    assert.equal(WORKERS.find(worker => worker.name === 'follow-defense-actions').kind, 'typescript', 'existing executor boundary retained');
    for (const runtime of ['node', 'tsx']) {
        const selected = resolveWorkerLaunch(definition, { runtime, once: false, dryRun: false, restartDelayMs: 1000 }, { ...process.env, RAID_SESSIONS_RUNTIME: 'typescript', FORBIDDEN_FIXTURE_SECRET: 'not-forwarded' }, 0);
        assert.equal(selected.command, binary); assert.deepEqual(selected.args, ['--telemetry-json']); assert.equal(selected.options.uid, 65534);
        assert.equal(selected.options.env.FORBIDDEN_FIXTURE_SECRET, undefined); assert.equal(selected.options.env.RAID_SESSIONS_RUNTIME, undefined);
    }
    await assert.rejects(readFile('/app/dist/workers/raid_sessions.worker.js'), error => error.code === 'ENOENT');
    await waitFor(() => currentNative(), 'natural native supervisor startup'); await assertNative(); paused = await pause();
    const root = paused.supervisor, siblings = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => [row.worker, row.pid]);
    assert(siblings.some(([name]) => name === 'follow-defense-actions'));
    console.log('PASS sixth native registry and actual UID65534 child; node/tsx native selection, restricted environment, retired entrypoint absent, existing TS action executor retained');

    const help = await finished(launch(binary, ['--help'], { PATH: process.env.PATH }, { uid: 65534, gid: 65534 })); assert.equal(help.code, 0);
    for (const flag of ['--once', '--database', '--env-file', '--telemetry-json', '--dry-run']) assert(help.output.includes(flag));
    const dry = await finished(launch(binary, ['--dry-run', '--env-file', '/no-such-fixture'], {}, { uid: 65534, gid: 65534 })); assert.equal(dry.code, 0);
    assert.deepEqual(JSON.parse(dry.output.trim()), { worker: 'raid-sessions', batchSize: 200 });
    assert.notEqual((await finished(launch(binary, ['--invalid-fixture-flag'], {}))).code, 0);
    const dotenvDir = `/tmp/raid-sessions-dotenv-${process.pid}`; await mkdir(dotenvDir); directories.add(dotenvDir);
    await writeFile(`${dotenvDir}/.env`, `MONGO_URI=${uri.href}\nDRAGONFLY_HOST=redis\nDRAGONFLY_PORT=6379\n`);
    assert.notEqual((await finished(launch(binary, ['--once'], { PATH: process.env.PATH }, { cwd: dotenvDir, uid: 65534, gid: 65534 }))).code, 0, 'existing cwd .env must never be loaded implicitly');
    const explicitDb = fixtureDatabase('explicit'), envFile = `/tmp/raid-sessions-fixture-${process.pid}-${++sequence}.env`; files.add(envFile);
    await writeFile(envFile, `MONGO_URI=mongodb://mongo:27017/raid_sessions_fixture_wrong\nDRAGONFLY_HOST=redis\nDRAGONFLY_PORT=6379\n`); await chmod(envFile, 0o644);
    const explicit = await finished(launch(binary, ['--once', '--telemetry-json', '--database', explicitDb.databaseName, '--env-file', envFile], { PATH: process.env.PATH }, { uid: 65534, gid: 65534 }));
    assert.equal(explicit.code, 0); assert.equal(frames(explicit.output)[0].success, true);
    console.log('PASS documented CLI, no implicit dotenv, disconnected dry run, invalid flags, explicit env-file and database selection');

    const retained = session('retention', { retentionHours: 24, expiresAt: new Date(now + HOUR), purgeAt: new Date(now + 2 * HOUR) });
    const oldFollower = follower(retained, 1), beyond = follower(retained, 2, { purgeAt: new Date(now + 100 * HOUR) });
    await both({ sessions: [retained], followers: [oldFollower, beyond] });
    const retentionProxy = await mongoHoldProxy(actual, body => setsField(body, 'sessions', 'retentionHours'));
    const widening = launch(binary, ['--once', '--telemetry-json'], nativeEnv(actual, { MONGO_URI: retentionProxy.uri }), { uid: 65534, gid: 65534 });
    await retentionProxy.held();
    const expectedPurge = +retained.startedAt + 73 * HOUR;
    assert.equal(+(await coll(actual, 'followers').findOne({ _id: oldFollower._id })).purgeAt, expectedPurge, 'TTL extended before session advertises retention');
    assert.equal((await coll(actual, 'sessions').findOne({ _id: retained._id })).retentionHours, 24);
    retentionProxy.release(); assert.equal((await finished(widening)).code, 0); retentionProxy.check(); await retentionProxy.close();
    await reference(referenceDb, { mode: 'tick' }); await parity();
    assert.equal(+(await coll(actual, 'followers').findOne({ _id: beyond._id })).purgeAt, +beyond.purgeAt, '$max never shortens an existing TTL');
    await success(); await reference(referenceDb, { mode: 'tick' }); await parity();
    console.log('PASS retention publishes follower TTL first, preserves longer TTLs and capture boundary, and remains restart/idempotence equivalent to shared TypeScript');
    await reset();

    const futureAt = Date.now() + 600000;
    const backfill = session('backfill', { backfillDone: false, backfillUntil: new Date(futureAt + 1000), captureUntil: new Date(futureAt + 300000) });
    const events = Array.from({ length: 205 }, (_, index) => ({ _id: new ObjectId((index + 1).toString(16).padStart(24, '0')), channelID: backfill.channelID,
        source: 'twitch-eventsub', type: 'channel.follow.received', eventKey: `backfill-${index}`, occurredAt: new Date(now - 40000 + index), journaledAt: new Date(now - 1000),
        payload: { event: index === 10 ? {} : { user_id: String(1000 + index), user_login: `follower${index}`, user_name: `Follower${index}` } } }));
    const irrelevant = [
        { ...events[0], _id: new ObjectId('000000000000000000000500'), source: 'other', eventKey: 'wrong-source' },
        { ...events[0], _id: new ObjectId('000000000000000000000501'), channelID: 'another-channel', eventKey: 'wrong-channel' },
        { ...events[0], _id: new ObjectId('000000000000000000000502'), occurredAt: new Date(now - HOUR), eventKey: 'too-early' },
        { ...events[0], _id: new ObjectId('000000000000000000000503'), occurredAt: new Date(futureAt), eventKey: 'future' },
    ];
    await both({ sessions: [backfill], events: [...events, ...irrelevant] });
    assert.equal((await success()).events, 200); await reference(referenceDb, { mode: 'tick' }); await parity();
    let progress = await coll(actual, 'sessions').findOne({ _id: backfill._id }); assert.equal(progress.backfillCursor, events[199]._id.toHexString()); assert.equal(progress.backfillDone, false);
    assert.equal(await coll(actual, 'followers').countDocuments(), 199);
    assert.equal((await success()).events, 6); await reference(referenceDb, { mode: 'tick' }); await parity();
    progress = await coll(actual, 'sessions').findOne({ _id: backfill._id }); assert.equal(progress.backfillDone, true); assert.equal(progress.backfillCursor, irrelevant[3]._id.toHexString());
    assert.equal(await coll(actual, 'followers').countDocuments(), 204, 'missing-user and future follows never persisted');
    assert.equal((await success()).events, 0); await reference(referenceDb, { mode: 'tick' }); await parity();
    const noFollow = { channelID: backfill.channelID, eventID: 'invalid-reference', followerID: 'bad', followerLogin: '', followerName: '', followedAt: 'invalid', receivedAt: now };
    assert.equal(await reference(referenceDb, { mode: 'follow', follow: noFollow }), null);
    console.log('PASS ObjectId cursor, bounded 200 seen events, incomplete/restart resume, ignored rows, future-follow rejection, complete persisted BSON/default parity');
    await reset();

    // Late raid attribution uses latest applicable session rather than the backfill owner.
    const older = session('late', { backfillDone: false, backfillUntil: new Date(now), endedAt: new Date(now - 30000) });
    const newer = session('late-new', { channelID: older.channelID, startedAt: new Date(now - 30000) });
    const live = request(newer, 'live', { includeFuture: true, status: 'completed', requestedAt: new Date(now - 50000) });
    const lateEvent = { ...events[0], channelID: older.channelID, occurredAt: new Date(now - 20000), eventKey: 'late-attribution' };
    await both({ sessions: [older, newer], requests: [live], events: [lateEvent] }); await setState(newer, live);
    assert.equal((await success()).events, 2); await reference(referenceDb, { mode: 'tick' }); await parity();
    const attributed = await coll(actual, 'followers').findOne(); assert.equal(attributed.sessionID, newer._id); assert.deepEqual(attributed.eligibleRequestIDs, [live._id]); assert.deepEqual(attributed.queuedRequestIDs, [live._id]);
    assert.equal((await coll(actual, 'requests').findOne()).status, 'active'); assert.equal(await coll(actual, 'actions').countDocuments(), 1);
    await reset(); await clearState();
    for (const [stateExtra, expectedEligibility] of [
        [{ mode: 'normal' }, []], [{ expiresAt: now - 1 }, []],
        [{ raidSessionID: 'different-session' }, []], [{ raidRequestID: 'different-request' }, ['different-request']],
    ]) {
        await both({ sessions: [older, newer], requests: [live], events: [lateEvent] }); await setState(newer, live, stateExtra);
        await success(); await reference(referenceDb, { mode: 'tick' }); await parity(); assert.equal(await coll(actual, 'actions').countDocuments(), 0);
        const ineligible = await coll(actual, 'followers').findOne();
        assert.deepEqual(ineligible.eligibleRequestIDs, expectedEligibility); assert.deepEqual(ineligible.queuedRequestIDs, []);
        assert.equal((await coll(actual, 'requests').findOne({ _id: live._id })).status, 'completed', 'a different request state cannot reactivate the original completed request');
        await reset(); await clearState();
    }
    console.log('PASS late attribution, matching live Redis attack eligibility and completed request reactivation; normal/expired/other-session state adds no eligibility, while another request marker cannot authorize the original request');

    const bulkSession = session('bulk'), bulkRequest = request(bulkSession);
    const bulkFollowers = Array.from({ length: 201 }, (_, index) => follower(bulkSession, index));
    const tooLate = follower(bulkSession, 10000, { recordedAt: new Date(now + 1) });
    await both({ sessions: [bulkSession], requests: [bulkRequest], followers: [...bulkFollowers, tooLate] });
    assert.equal((await success()).events, 200); await reference(referenceDb, { mode: 'tick' }); await parity();
    assert.equal(await coll(actual, 'actions').countDocuments(), 200); assert.equal((await coll(actual, 'requests').findOne()).status, 'active');
    assert.equal((await success()).events, 1); await reference(referenceDb, { mode: 'tick' }); await parity();
    assert.equal(await coll(actual, 'actions').countDocuments(), 201); assert.equal((await coll(actual, 'requests').findOne()).status, 'completed');
    await success(); await reference(referenceDb, { mode: 'tick' }); await parity();
    assert.equal(await coll(actual, 'actions').countDocuments(), 201);
    assert.deepEqual((await coll(actual, 'followers').findOne({ _id: tooLate._id })).queuedRequestIDs, []);
    const action = await coll(actual, 'actions').findOne(); assert.equal(action.authorization, 'manual'); assert.equal(action.kind, 'ban'); assert.equal(action.mode, 'attack');
    assert.equal(action._id, id(bulkSession.channelID, `${bulkRequest._id}:${action.followerID}`, 'ban')); assert.equal(action.reason, 'DimaBot confirmed raid session moderation');
    assert.equal(+(await coll(actual, 'controls').findOne({ _id: bulkSession.channelID })).pendingUntil, +bulkRequest.expiresAt);
    console.log('PASS bounded 200 admission, exact shared-utility action IDs/defaults/timestamps/BSON, durable controls, historical cutoff, replay and completion idempotence');
    await reset();
    await both({ sessions: [retained, backfill, bulkSession], requests: [bulkRequest], followers: bulkFollowers.slice(0, 200), events: events.slice(0, 200) });
    assert.equal((await success()).events, 401, 'one retention + 200 seen events + 200 admitted followers share one bounded tick');
    await reference(referenceDb, { mode: 'tick' }); await parity(); assert.equal(await coll(actual, 'actions').countDocuments(), 200);
    console.log('PASS actual maximal 401-event tick preserves fixed retention/backfill/admission ordering and raw shared-reference parity');
    await reset();
    const individualSession = session('individual'), individual = request(individualSession, 'individual', { userID: '77' });
    const duplicateUser = [follower(individualSession, 1, { userID: '77' }), follower(individualSession, 2, { userID: '77' }), follower(individualSession, 3, { userID: '88' })];
    await both({ sessions: [individualSession], requests: [individual], followers: duplicateUser });
    assert.equal((await success()).events, 2); await reference(referenceDb, { mode: 'tick' }); await parity();
    assert.equal(await coll(actual, 'actions').countDocuments(), 1, 'request/user identity deduplicates repeated follows by one user');
    assert.deepEqual((await coll(actual, 'followers').findOne({ userID: '88' })).queuedRequestIDs, [], 'individual request cannot widen to other users');
    console.log('PASS individual user filtering and repeated-user follows mark both records but admit one durable action');
    await reset();

    const recoverySession = session('recovery');
    const admitted = request(recoverySession, 'published', { status: 'authorizing', includeFuture: true, requestedAt: new Date(now - 20000) });
    const unpublishedSession = session('unpublished'), unpublished = request(unpublishedSession, 'unpublished', { status: 'authorizing', requestedAt: new Date(now - 19000) });
    const disabledSession = session('disabled'), disabled = request(disabledSession);
    const attackOffSession = session('attack-off'), attackOff = request(attackOffSession);
    const expiredSession = session('expired'), expired = request(expiredSession, 'expired', { expiresAt: new Date(now - 1) });
    const cancelledSession = session('cancelled'), cancelled = request(cancelledSession, 'cancelled', { status: 'cancelled' });
    const fencedSession = session('fenced'), fenced = request(fencedSession);
    await both({ sessions: [recoverySession, unpublishedSession, disabledSession, attackOffSession, expiredSession, cancelledSession, fencedSession],
        requests: [admitted, unpublished, disabled, attackOff, expired, cancelled, fenced],
        followers: [recoverySession, unpublishedSession, disabledSession, attackOffSession, expiredSession, cancelledSession, fencedSession].map((s, i) => follower(s, i, { recordedAt: new Date(now - 60000) })),
        settings: [new Settings({ channelID: disabledSession.channelID, enabled: false }).toObject(), new Settings({ channelID: attackOffSession.channelID, attackModeEnabled: false }).toObject()],
        controls: [new Controls({ _id: fencedSession.channelID, cancelledThrough: new Date(now) }).toObject()] });
    await setState(recoverySession, admitted);
    for (let i = 0; i < 6; i++) { await success(); await reference(referenceDb, { mode: 'tick' }); }
    await parity();
    assert.equal((await coll(actual, 'requests').findOne({ _id: admitted._id })).status, 'active');
    assert.equal((await coll(actual, 'requests').findOne({ _id: unpublished._id })).status, 'cancelled');
    for (const req of [disabled, attackOff, fenced, cancelled]) assert.equal((await coll(actual, 'requests').findOne({ _id: req._id })).status, 'cancelled');
    assert.equal((await coll(actual, 'requests').findOne({ _id: expired._id })).status, 'expired');
    assert.equal(await coll(actual, 'actions').countDocuments(), 1);
    console.log('PASS authorizing crash recovery requires actually published live state; unpublished/expired/cancelled/disabled/attack-disabled/control-fenced requests grant no action');
    await reset(); await clearState();

    const raceSession = session('race'), raceRequest = request(raceSession), raceFollower = follower(raceSession, 77);
    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    const actionProxy = await mongoHoldProxy(actual, body => updatesCollection(body, 'actions'));
    const racing = launch(binary, ['--once', '--telemetry-json'], nativeEnv(actual, { MONGO_URI: actionProxy.uri }), { uid: 65534, gid: 65534 });
    await actionProxy.held();
    assert.equal(await coll(actual, 'actions').countDocuments(), 0);
    assert.equal(+(await coll(actual, 'controls').findOne({ _id: raceSession.channelID })).pendingUntil, +raceRequest.expiresAt, 'control discoverability precedes held action insertion');
    await reference(actual, { mode: 'cancel', channelID: raceSession.channelID });
    actionProxy.release(); assert.equal((await finished(racing)).code, 0); actionProxy.check(); await actionProxy.close();
    assert.equal(await coll(actual, 'actions').countDocuments(), 1, 'late enqueue is durable and still fenced at execution');
    assert.deepEqual(await reference(actual, { mode: 'execute' }), []);
    assert.equal((await coll(actual, 'actions').findOne()).status, 'cancelled');
    console.log('PASS actual held enqueue exposes durable control first; concurrent Reset fences late native admission at existing TS executor without any provider call');
    await reset();

    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    const leaseProxy = await mongoHoldProxy(actual, body => body.find === names.followers);
    const leased = launch(binary, ['--once', '--telemetry-json'], nativeEnv(actual, { MONGO_URI: leaseProxy.uri }), { uid: 65534, gid: 65534 });
    await leaseProxy.held();
    const owner = await coll(actual, 'requests').findOne({ _id: raceRequest._id }); assert(owner.leaseToken); assert(+owner.lockedUntil > Date.now());
    assert.equal((await success()).events, 0, 'second process cannot claim currently leased request');
    const replacementToken = 'fixture-replacement-owner', replacementUntil = new Date(Date.now() + 60000);
    await coll(actual, 'requests').updateOne({ _id: raceRequest._id }, { $set: { leaseToken: replacementToken, lockedUntil: replacementUntil } });
    leaseProxy.release(); assert.equal((await finished(leased)).code, 0); leaseProxy.check(); await leaseProxy.close();
    const fencedOwner = await coll(actual, 'requests').findOne({ _id: raceRequest._id });
    assert.equal(fencedOwner.leaseToken, replacementToken); assert.equal(+fencedOwner.lockedUntil, +replacementUntil); assert.equal(fencedOwner.status, 'pending');
    assert.equal(await coll(actual, 'actions').countDocuments(), 1);
    await coll(actual, 'requests').updateOne({ _id: raceRequest._id }, { $set: { lockedUntil: new Date(0), leaseToken: '' } });
    await success(); assert.equal(await coll(actual, 'actions').countDocuments(), 1, 'replacement deduplicates action');
    assert.deepEqual(await reference(actual, { mode: 'execute' }), [{ id: id(raceSession.channelID, `${raceRequest._id}:77`, 'ban'), followerID: '77', requestID: raceRequest._id }]);
    assert.equal((await coll(actual, 'actions').findOne()).status, 'succeeded', 'existing injected executor consumes native document');
    console.log('PASS real contention excludes second claim; replaced lease survives stale completion/release; retry deduplicates and native action is executable by existing TS boundary');
    await reset();

    // A late B marker reassigns membership after native admission. Executor must cancel A.
    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] }); await success();
    const lateMarker = { eventID: 'late-new-boundary', channelID: raceSession.channelID, channelLogin: 'fixture', channelName: 'Fixture', raiderChannelID: 'next', raiderChannelLogin: 'next', raiderChannelName: 'Next', raidViewers: 5,
        createdAt: +raceFollower.followedAt - 1, expiresAt: now + 300000 };
    const repaired = await reference(actual, { mode: 'session', marker: lateMarker });
    assert.equal((await coll(actual, 'followers').findOne()).sessionID, repaired._id);
    assert.deepEqual(await reference(actual, { mode: 'execute' }), []); assert.equal((await coll(actual, 'actions').findOne()).status, 'cancelled');
    console.log('PASS source-backed late raid producer repairs attribution and existing executor cancels previously admitted native A action');
    await reset();

    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    await actual.command({ collMod: names.actions, validator: { channelID: { $ne: raceSession.channelID } }, validationLevel: 'strict', validationAction: 'error' });
    await failOnce(actual);
    assert.equal(await coll(actual, 'actions').countDocuments(), 0); assert.deepEqual((await coll(actual, 'followers').findOne()).queuedRequestIDs, []);
    assert.equal((await coll(actual, 'requests').findOne()).leaseToken, '', 'ordinary Mongo error releases owned request lease');
    await actual.command({ collMod: names.actions, validator: {}, validationLevel: 'strict' }); await success();
    assert.equal(await coll(actual, 'actions').countDocuments(), 1);
    await reset();
    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    await actual.command({ collMod: names.followers, validator: { queuedRequestIDs: { $size: 0 } }, validationLevel: 'strict', validationAction: 'error' });
    await failOnce(actual); assert.equal(await coll(actual, 'actions').countDocuments(), 1, 'action is durable before follower acknowledgement failure');
    assert.deepEqual((await coll(actual, 'followers').findOne()).queuedRequestIDs, []);
    await actual.command({ collMod: names.followers, validator: {}, validationLevel: 'strict' }); await success();
    assert.equal(await coll(actual, 'actions').countDocuments(), 1); assert.deepEqual((await coll(actual, 'followers').findOne()).queuedRequestIDs, [raceRequest._id]);
    await reset();
    await seed(actual, { sessions: [backfill], events: [events[0]] });
    const wrongType = `twitch:${backfill.channelID}:follow-defense:state`; keys.add(wrongType); await redis.hSet(wrongType, { fixture: 'wrong-type' });
    await failOnce(actual);
    assert.equal((await coll(actual, 'sessions').findOne()).backfillCursor, '', 'Redis failure never acknowledges journal cursor');
    assert.equal((await coll(actual, 'sessions').findOne()).backfillDone, false); assert.equal(await coll(actual, 'followers').countDocuments(), 1, 'partial durable follower is safe to replay');
    await redis.del(wrongType); await success(); assert.equal(await coll(actual, 'followers').countDocuments(), 1); assert.equal((await coll(actual, 'sessions').findOne()).backfillDone, true);
    for (const settings of [
        { DRAGONFLY_HOST: '127.0.0.1', DRAGONFLY_PORT: '1' },
        { MONGO_URI: `mongodb://127.0.0.1:1/${actual.databaseName}?serverSelectionTimeoutMS=1000&connectTimeoutMS=1000` },
    ]) {
        const failure = await once(actual, settings); assert.notEqual(failure.code, 0); assert.equal(failure.signal, null);
        for (const frame of frames(failure.output)) { assert.equal(frame.success, false); assert.equal(frame.events, 0); }
    }
    console.log('PASS ordinary Mongo enqueue/ack and Redis WRONGTYPE failures emit failed0; Mongo/Redis initialization failures exit nonzero; unacknowledged work replays without duplicate actions/followers');
    await reset(); await clearState();

    // Exercise the normal binary loop, independently of the one-tick parity
    // oracle. Eight ready ticks span full200 batches and otherwise-ready work.
    const scheduleDb = fixtureDatabase('schedule'); await indexes(scheduleDb);
    const scheduleBackfill = session('schedule-backfill', { backfillDone: false, backfillUntil: new Date(now) });
    const scheduleBulk = session('schedule-bulk'), scheduleRequest = request(scheduleBulk, 'bulk', { requestedAt: new Date(now - 9000) });
    const shortSessions = Array.from({ length: 3 }, (_, index) => session(`schedule-short-${index}`));
    const shortRequests = shortSessions.map((s, index) => request(s, 'short', { requestedAt: new Date(now - 8000 + index) }));
    const futureSession = session('schedule-future'), futureRequest = request(futureSession, 'future', { status: 'active', includeFuture: true, nextAttemptAt: new Date(Date.now() + 60000) });
    const retentionSessions = Array.from({ length: 8 }, (_, index) => session(`schedule-retention-${index}`, { retentionHours: 24 }));
    const scheduleEvents = Array.from({ length: 401 }, (_, index) => ({ ...events[0], _id: new ObjectId((index + 2000).toString(16).padStart(24, '0')),
        eventKey: `schedule-event-${index}`, channelID: scheduleBackfill.channelID, occurredAt: new Date(now - 40000 + index),
        payload: { event: { user_id: String(20000 + index), user_login: `schedule${index}`, user_name: `Schedule${index}` } } }));
    await seed(scheduleDb, { sessions: [scheduleBackfill, scheduleBulk, ...shortSessions, futureSession, ...retentionSessions],
        requests: [scheduleRequest, ...shortRequests, futureRequest], events: scheduleEvents,
        followers: [...Array.from({ length: 401 }, (_, index) => follower(scheduleBulk, 30000 + index)), ...shortSessions.map((s, index) => follower(s, 40000 + index))] });
    await setState(futureSession, futureRequest);
    const scheduleProxy = await mongoHoldProxy(scheduleDb, () => false);
    const scheduling = launch(binary, ['--telemetry-json'], nativeEnv(scheduleDb, { MONGO_URI: scheduleProxy.uri }), { uid: 65534, gid: 65534 });
    const scheduleFrames = observeBatches(scheduling);
    await waitFor(() => { scheduleFrames.check(); scheduleProxy.check(); return scheduleFrames.rows.length >= 9; }, 'continuous ready burst drains then future-only wait', 30000);
    await stopContinuous(scheduling, scheduleFrames); scheduleProxy.check();
    const burst = scheduleFrames.rows.slice(0, 8);
    assert.deepEqual(burst.map(row => row.events), [401, 202, 3, 2, 201, 2, 1, 1], 'bounded phases drain full batches, other request channels and all retention work');
    assert(burst.every(row => row.success)); assert.equal(scheduleFrames.rows[8].events, 0); assert.equal(scheduleFrames.rows[8].success, true);
    // Exclude each next tick's actual work, then bound EVERY ready transition.
    // An aggregate alone would miss a loop that sleeps only for partial batches
    // or other ready channels. The additional aggregate guard catches broad drift.
    const readyWait = assertReadyTransitions(burst, 'mixed backlog');
    assert(readyWait < 4900, `seven ready boundaries introduced ${Math.round(readyWait)}ms residual wait`);
    assert(waitResidual(burst[7], scheduleFrames.rows[8]) >= 800, 'final nonzero work with only future-active request must wait roughly one second');
    const actionOrder = scheduleProxy.parsed.filter(row => updatesCollection(row.body, 'actions')).flatMap(row => updates(row.body).map(update => update.u?.$setOnInsert?.raidRequestID)).filter(Boolean);
    const runs = actionOrder.filter((value, index) => index === 0 || actionOrder[index - 1] !== value);
    assert.deepEqual(runs, [scheduleRequest._id, ...shortRequests.map(row => row._id), scheduleRequest._id], 'due channels run before full-batch request resumes according to existing sort');
    assert.equal(await coll(scheduleDb, 'actions').countDocuments(), 404); assert.equal(await coll(scheduleDb, 'followers').countDocuments({ sessionID: scheduleBackfill._id }), 401);
    assert.equal(await coll(scheduleDb, 'sessions').countDocuments({ retentionHours: { $lt: 72 } }), 0);
    assert.equal((await coll(scheduleDb, 'sessions').findOne({ _id: scheduleBackfill._id })).backfillDone, true);
    const stillFuture = await coll(scheduleDb, 'requests').findOne({ _id: futureRequest._id });
    assert.equal(stillFuture.status, 'active'); assert.equal(+stillFuture.nextAttemptAt, +futureRequest.nextAttemptAt); assert.equal(stillFuture.leaseToken, '');
    await scheduleProxy.close(); await clearState();
    console.log('PASS continuous full200/other-channel ready burst drains without per-tick one-second waits, preserves request fairness and 401 bound, then final nonzero/future-only work waits');

    await reset(scheduleDb);
    const skippedEvents = Array.from({ length: 1001 }, (_, index) => ({ ...scheduleEvents[0], _id: new ObjectId((index + 10000).toString(16).padStart(24, '0')),
        eventKey: `skipped-event-${index}`, payload: { event: {} } }));
    await seed(scheduleDb, { sessions: [scheduleBackfill], events: skippedEvents });
    const skipping = launch(binary, ['--telemetry-json'], nativeEnv(scheduleDb), { uid: 65534, gid: 65534 });
    const skippedFrames = observeBatches(skipping);
    await waitFor(() => { skippedFrames.check(); return skippedFrames.rows.length >= 7; }, 'continuous skipped journal rows drain by raw fetched size');
    await stopContinuous(skipping, skippedFrames);
    assert.deepEqual(skippedFrames.rows.slice(0, 7).map(row => row.events), [200, 200, 200, 200, 200, 1, 0]);
    const skippedWait = assertReadyTransitions(skippedFrames.rows.slice(0, 6), 'skipped journal backlog');
    assert(skippedWait < 3500, `five full skipped-row boundaries introduced ${Math.round(skippedWait)}ms residual wait`);
    assert(waitResidual(skippedFrames.rows[5], skippedFrames.rows[6]) >= 800, 'final partial skipped journal batch waits when drained');
    assert.equal(await coll(scheduleDb, 'followers').countDocuments(), 0);
    const skippedProgress = await coll(scheduleDb, 'sessions').findOne(); assert.equal(skippedProgress.backfillDone, true); assert.equal(skippedProgress.backfillCursor, skippedEvents.at(-1)._id.toHexString());

    await reset(scheduleDb);
    const partialRequest = request(scheduleBulk, 'partial'), futureWaitRequest = { ...futureRequest, nextAttemptAt: new Date(Date.now() + 60000) };
    await seed(scheduleDb, { sessions: [scheduleBackfill, scheduleBulk, futureSession], requests: [partialRequest, futureWaitRequest], events: scheduleEvents.slice(0, 100),
        followers: Array.from({ length: 100 }, (_, index) => follower(scheduleBulk, 60000 + index)) });
    await setState(futureSession, futureWaitRequest);
    const partial = launch(binary, ['--telemetry-json'], nativeEnv(scheduleDb), { uid: 65534, gid: 65534 });
    const partialFrames = observeBatches(partial);
    await waitFor(() => { partialFrames.check(); return partialFrames.rows.length >= 2; }, 'partial100 plus partial100 waits despite aggregate200');
    await stopContinuous(partial, partialFrames);
    assert.deepEqual(partialFrames.rows.slice(0, 2).map(row => row.events), [200, 0]);
    assert(waitResidual(partialFrames.rows[0], partialFrames.rows[1]) >= 800, 'combined100 backfill plus100 admission is not a full-source backlog signal');
    assert.equal(await coll(scheduleDb, 'actions').countDocuments(), 100); assert.equal(await coll(scheduleDb, 'followers').countDocuments({ sessionID: scheduleBackfill._id }), 100);
    assert.equal((await coll(scheduleDb, 'requests').findOne({ _id: partialRequest._id })).status, 'completed');
    assert.equal(+(await coll(scheduleDb, 'requests').findOne({ _id: futureWaitRequest._id })).nextAttemptAt, +futureWaitRequest.nextAttemptAt);
    await clearState();
    console.log('PASS continuous skipped full200 journal batches drain by fetched count; combined partial100+100 and future-active zero-eligible work wait instead of treating total events as backlog');

    await reset(scheduleDb);
    await seed(scheduleDb, { sessions: [raceSession, scheduleBackfill], requests: [raceRequest], followers: [raceFollower], events: scheduleEvents.slice(0, 201) });
    await scheduleDb.command({ collMod: names.actions, validator: { channelID: { $ne: raceSession.channelID } }, validationLevel: 'strict', validationAction: 'error' });
    const errorProxy = await mongoHoldProxy(scheduleDb, body => body.find === names.events && Boolean(body.filter?._id));
    const retrying = launch(binary, ['--telemetry-json'], nativeEnv(scheduleDb, { MONGO_URI: errorProxy.uri }), { uid: 65534, gid: 65534 });
    const errorFrames = observeBatches(retrying);
    await errorProxy.held(); errorFrames.check(); assert.equal(errorFrames.rows.length, 1, 'second journal page barrier follows exactly one failed tick');
    assert.equal((await coll(scheduleDb, 'sessions').findOne({ _id: scheduleBackfill._id })).backfillCursor, scheduleEvents[199]._id.toHexString(), 'first tick durably finishes full200 journal phase before admission fails');
    errorProxy.release();
    await waitFor(() => { errorFrames.check(); return errorFrames.rows.length >= 2; }, 'continuous error retry waits instead of spinning');
    await stopContinuous(retrying, errorFrames); errorProxy.check(); await errorProxy.close();
    assert(errorFrames.rows.slice(0, 2).every(row => row.success === false && row.events === 0));
    assert(waitResidual(errorFrames.rows[0], errorFrames.rows[1]) >= 800, 'ready backlog errors retain the one-second retry wait');
    assert.equal(await coll(scheduleDb, 'actions').countDocuments(), 0); assert.deepEqual((await coll(scheduleDb, 'followers').findOne({ _id: raceFollower._id })).queuedRequestIDs, []);
    assert.equal((await coll(scheduleDb, 'sessions').findOne({ _id: scheduleBackfill._id })).backfillDone, true);
    assert.equal(await coll(scheduleDb, 'followers').countDocuments({ sessionID: scheduleBackfill._id }), 201);
    assert.equal((await coll(scheduleDb, 'requests').findOne()).leaseToken, '');
    await scheduleDb.command({ collMod: names.actions, validator: {}, validationLevel: 'strict' });
    await success(scheduleDb); assert.equal(await coll(scheduleDb, 'actions').countDocuments(), 1);
    console.log('PASS continuous error after full200 backfill still waits one second and emits failed0; earlier journal progress persists while failed admission remains unacknowledged and recovers after repair');

    const faults = fixtureDatabase('faults'); await indexes(faults);
    await seed(faults, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    const watchdogProxy = await mongoHoldProxy(faults, body => updatesCollection(body, 'actions'));
    const started = Date.now();
    const watchdog = launch(binary, ['--once', '--telemetry-json'], nativeEnv(faults, { MONGO_URI: watchdogProxy.uri }), { uid: 65534, gid: 65534 });
    await watchdogProxy.held();
    const watchdogOwner = await coll(faults, 'requests').findOne(); assert(watchdogOwner.leaseToken); assert(+watchdogOwner.lockedUntil > Date.now());
    const watchdogExit = await finished(watchdog, 25000);
    const elapsed = Date.now() - started; assert(elapsed >= 18000 && elapsed <= 25000, `hard tick watchdog elapsed ${elapsed}ms`);
    assert.notEqual(watchdogExit.code, 0); assert.equal(watchdogExit.signal, null); assert.equal(watchdogProxy.snapshot().released, false);
    assert.equal(frames(watchdogExit.output).length, 0, 'hard OS-thread watchdog exits without advertising a completed tick or batch frame');
    assert.match(watchdogExit.output, /Raid session active work exceeded 20-second watchdog; durable work retained for recovery/, 'dedicated hard-watchdog diagnostic must explain uncompleted durable work');
    assert.equal(await coll(faults, 'actions').countDocuments(), 0); assert.deepEqual((await coll(faults, 'followers').findOne()).queuedRequestIDs, []);
    const abandoned = await coll(faults, 'requests').findOne(); assert.equal(abandoned.leaseToken, watchdogOwner.leaseToken, 'watchdog never claims safe completion or releases unfinished owner');
    assert.equal(+abandoned.lockedUntil, +watchdogOwner.lockedUntil);
    // Persisted work/lease assertions above are prerequisites for classifying
    // only a reset correlated with this independently confirmed hard exit.
    watchdogProxy.checkConfirmedWatchdogExit(watchdogExit, elapsed);
    await watchdogProxy.close(); assert.equal((await success(faults)).events, 0, 'restart respects unexpired request lease');
    await coll(faults, 'requests').updateOne({ _id: raceRequest._id, leaseToken: watchdogOwner.leaseToken }, { $set: { lockedUntil: new Date(0) } });
    await success(faults); await success(faults); assert.equal(await coll(faults, 'actions').countDocuments(), 1); assert.deepEqual((await coll(faults, 'followers').findOne()).queuedRequestIDs, [raceRequest._id]);
    console.log(`PASS actual held Mongo command triggers ${elapsed}ms hard watchdog with diagnostic and zero batch frames; unchanged request lease survives exit and recovers exactly once after private fixture expiry`);
    await reset(faults);

    const signalFollowers = Array.from({ length: 401 }, (_, index) => follower(raceSession, 50000 + index));
    await seed(faults, { sessions: [raceSession], requests: [raceRequest], followers: signalFollowers });
    const signalProxy = await mongoHoldProxy(faults, body => updatesCollection(body, 'actions'));
    const signaled = launch(binary, ['--telemetry-json'], nativeEnv(faults, { MONGO_URI: signalProxy.uri }), { uid: 65534, gid: 65534 });
    await signalProxy.held(); assert(signaled.kill('SIGTERM')); await delay(300); signalProxy.check();
    assert.equal(signaled.exitCode, null); assert.equal(signaled.signalCode, null, 'SIGTERM drains in-flight operation');
    signalProxy.release(); const signalExit = await finished(signaled, 25000); signalProxy.check(); await signalProxy.close();
    assert.equal(signalExit.code, 0); assert.equal(signalExit.signal, null); assert.equal(frames(signalExit.output).length, 1);
    assert.equal(frames(signalExit.output)[0].events, 200);
    assert.equal(await coll(faults, 'actions').countDocuments(), 200);
    assert.equal(await coll(faults, 'followers').countDocuments({ queuedRequestIDs: raceRequest._id }), 200);
    assert.equal(await coll(faults, 'followers').countDocuments({ queuedRequestIDs: { $ne: raceRequest._id } }), 201, 'immediately ready next batch remains untouched after signal');
    const signalRequest = await coll(faults, 'requests').findOne(); assert.equal(signalRequest.leaseToken, ''); assert.equal(signalRequest.status, 'active');
    console.log('PASS SIGTERM during held first action drains exactly current200 tick, releases owned lease and leaves immediately ready201 backlog untouched');

    // Kill the actual supervised child, without mutating another managed worker.
    const killed = paused; stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'actual supervisor replacement');
    assert.equal(replacement.supervisor, root); await assertNative();
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => [row.worker, row.pid]), siblings);
    await seed(actual, { sessions: [raceSession], requests: [raceRequest], followers: [raceFollower] });
    await waitFor(async () => await coll(actual, 'actions').countDocuments() === 1, 'replacement performs real admission');
    await waitFor(async () => (await records()).some(row => row.event === 'batch' && row.pid === replacement.pid && row.frame.events === 1 && row.frame.success), 'replacement native success metadata');
    paused = await pause();
    console.log('PASS real supervisor replaces only killed raid-sessions native child, siblings stay stable, replacement admits real work and reports bounded metadata');

    const idleDb = fixtureDatabase('idle'), selected = new URL(uri); selected.pathname = `/${idleDb.databaseName}`;
    const auxiliary = launch(process.execPath, ['/app/dist/workers/cron.index.js'], { ...process.env, MONGO_URI: selected.href, CRON_WORKER_RUNTIME: 'tsx', RAID_SESSIONS_RUNTIME: 'typescript', RAID_SESSIONS_FIXTURE_SCOPE: 'idle' });
    const idleChild = await waitFor(() => currentNative('idle'), 'tsx supervisor native idle startup'); await assertNative('idle');
    await waitFor(async () => (await records('idle')).some(row => row.event === 'batch' && row.frame.success), 'idle native pass');
    auxiliary.kill('SIGTERM'); const idleExit = await finished(auxiliary, 25000); assert.equal(idleExit.code, 0); assert.equal(idleExit.signal, null);
    await waitFor(async () => (await records('idle')).some(row => row.event === 'exit' && row.pid === idleChild.pid && row.code === 0 && row.signal === null), 'native graceful idle shutdown');
    await delay(1100); assert.equal((await records('idle')).filter(row => row.event === 'spawn' && row.native).length, 1, 'shutdown cannot create replacement');
    // Check every captured metadata frame for privacy, bounds and failed0 semantics.
    for (const scope of ['main', 'idle']) for (const row of (await records(scope)).filter(row => row.event === 'batch')) frames(protocol + JSON.stringify(row.frame));
    assert.equal(await redis.get(unrelatedKey), 'preserve', 'no fixture ever flushes unrelated Redis data');
    process.kill(paused.pid, 'SIGCONT'); stopped.delete(paused.pid);
    console.log('PASS actual tsx supervisor ignores unsupported RAID_SESSIONS_RUNTIME key, idle SIGTERM exits cleanly without restart, metadata contains only bounded fields, unrelated Redis sentinel preserved');
} finally {
    await Promise.allSettled([...proxies].map(proxy => proxy.close()));
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...children].map(async child => {
        try { await bounded(child.completion, 5000, 'cleanup graceful child'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.completion.catch(() => {}), 2000, 'cleanup killed child').catch(() => {}); }
    }));
    await Promise.allSettled([...files].map(file => unlink(file)));
    await Promise.allSettled([...directories].map(directory => { assert.match(directory, /^\/tmp\/raid-sessions-dotenv-[0-9]+$/); return rm(directory, { recursive: true, force: true }); }));
    try {
        if (redis.isOpen && keys.size) await redis.del([...keys]);
        for (const name of owned) { assert.match(name, dbPattern); await client.db(name).dropDatabase(); }
    } finally { await bounded(client.close(), 5000, 'Mongo close').catch(() => {}); if (redis.isOpen) redis.destroy(); }
}
