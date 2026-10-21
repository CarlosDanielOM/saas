// Exact cron candidate + native AI usage consumer, isolated helper dependencies.
// Stage all files from ai-usage-receipts-rust-fixtures plus exact
// dima-analytics/src/store.mjs renamed analytics-store.mjs. No Polar calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire('/app/package.json');
const { MongoClient, BSON, ObjectId } = require('mongodb');
const { createClient } = require('redis');
const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo'); assert.equal(uri.port, '27017');
assert.equal(process.env.DRAGONFLY_HOST, 'redis'); assert.equal(process.env.DRAGONFLY_PORT, '6379');
const dbPattern = /^ai_usage_receipts_fixture_[a-zA-Z0-9_]+$/;
const databaseName = decodeURIComponent(uri.pathname.slice(1)); assert.match(databaseName, dbPattern);
assert.equal(process.env.AI_USAGE_RECEIPTS_RUNTIME, undefined, 'exercise actual native default');
assert([undefined, 'node'].includes(process.env.CRON_WORKER_RUNTIME));
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
const redis = createClient({ url: 'redis://redis:6379', socket: { reconnectStrategy: false } }); redis.on('error', () => {});
const owned = new Set([databaseName]), stopped = new Set(), children = new Set(), proxies = new Set(), files = new Set(), redisKeys = new Set();
const deadline = Date.now() + 270000;
const actual = client.db(databaseName);
function fixtureDatabase(label) {
    const name = `ai_usage_receipts_fixture_${process.pid}_${label}`;
    assert.match(name, dbPattern); assert(Buffer.byteLength(name) <= 63); owned.add(name); return client.db(name);
}
const referenceDb = fixtureDatabase('reference');
const model = async name => (await import(`/app/dist/schemas/${name}.schema.js`)).default;
const [Receipts, Daily, Dashboards, State, Users] = await Promise.all(['ai_usage_receipt', 'ai_usage_daily', 'ai_usage_dashboard', 'ai_usage_ledger_state', 'users'].map(model));
const names = { receipts: Receipts.collection.name, daily: Daily.collection.name, dashboards: Dashboards.collection.name, state: State.collection.name, users: Users.collection.name };
const source = await readFile('/tmp/saas-fixtures/analytics-store.mjs', 'utf8');
assert(source.startsWith("import pg from 'pg';\n"));
const { validateBatch } = await import('data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};')));
const binary = '/usr/local/bin/ai_usage_receipts', protocol = 'ai_usage_receipts:';
const queue = 'cron:ai-usage-receipts:queue', processing = 'cron:ai-usage-receipts:processing', dead = `${queue}:dead`, globalLock = 'worker:ai-usage-receipts:lock';
const DAY = 86400000, now = Date.now(), dayEnd = Math.floor(now / DAY) * DAY;
function nativeEnv(db = actual, extra = {}) {
    const selected = new URL(uri); selected.pathname = `/${db.databaseName}`;
    return { MONGO_URI: selected.href, DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', ...extra };
}
const clone = value => BSON.deserialize(BSON.serialize(value));
function normalize(value) {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value?._bsontype) return BSON.EJSON.serialize(value, { relaxed: false });
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    return value;
}
function stable(doc) {
    const result = { ...doc }; for (const key of ['_id', 'created_at', 'updated_at', 'refreshedAt']) delete result[key]; return normalize(result);
}
async function bounded(promise, ms, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
    finally { clearTimeout(timer); }
}
async function waitFor(check, label, ms = 15000) {
    const until = Math.min(deadline, Date.now() + ms);
    do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < until);
    throw new Error(`Timed out: ${label}`);
}
function launch(command, args, env, extra = {}) {
    assert(Date.now() < deadline, '270-second acceptance-suite deadline exceeded before launch');
    const child = spawn(command, args, { cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'], ...extra }); children.add(child);
    child.output = ''; const capture = chunk => { child.output = (child.output + chunk).slice(-40000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.completion = new Promise((resolve, reject) => {
        let exitedAt;
        child.once('error', reject); child.once('exit', () => { exitedAt = performance.now(); });
        child.once('close', (code, signal) => resolve({ code, signal, output: child.output, exitedAt }));
    });
    child.completion.catch(() => {}); return child;
}
async function finished(child, ms = 25000) {
    const remaining = deadline - Date.now(); assert(remaining > 0, '270-second acceptance-suite deadline exceeded');
    const result = await bounded(child.completion, Math.min(ms, remaining), 'fixture child completion'); children.delete(child); return result;
}
async function once(db = actual, extra = {}, args = []) {
    return finished(launch(binary, ['--once', '--telemetry-json', ...args], nativeEnv(db, extra), { uid: 65534, gid: 65534 }));
}
async function successOnce(db = actual, extra = {}, args = []) {
    const result = await once(db, extra, args); assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); return result;
}
let sequence = 0;
async function startReference(db, job) {
    const file = `/tmp/ai-usage-fixture-${process.pid}-${++sequence}.json`; files.add(file); await writeFile(file, JSON.stringify(job));
    return launch(process.execPath, ['/tmp/saas-fixtures/reference.mjs', file], { ...process.env, ...nativeEnv(db), NODE_OPTIONS: '', OBSERVABILITY_DISABLED: 'true' });
}
async function reference(db, job) {
    const result = await finished(await startReference(db, job)); assert.equal(result.code, 0, result.output);
    const line = result.output.split('\n').find(line => line.startsWith('AI_USAGE_REFERENCE:')); assert(line, result.output); return JSON.parse(line.slice('AI_USAGE_REFERENCE:'.length));
}
async function records(scope = 'main') {
    let text; try { text = await readFile('/tmp/saas-fixtures/ai-usage-spawns.jsonl', 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.scope === scope);
}
async function currentNative(scope = 'main') {
    const rows = await records(scope), exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.event === 'spawn' && row.native && !exited.has(row.pid)).at(-1);
}
async function pause() {
    for (let attempt = 0; attempt < 6; attempt++) {
        const prior = (await records()).filter(row => row.event === 'batch').length;
        await waitFor(async () => (await records()).filter(row => row.event === 'batch').length > prior, 'native reaches released-lock boundary');
        const row = await currentNative(); process.kill(row.pid, 'SIGSTOP'); stopped.add(row.pid);
        await waitFor(async () => /^State:\s+T/m.test(await readFile(`/proc/${row.pid}/status`, 'utf8')), 'native paused');
        if (!await redis.exists(globalLock)) return row;
        process.kill(row.pid, 'SIGCONT'); stopped.delete(row.pid);
    }
    throw new Error('Cannot pause native outside its global lease; refusing unsafe queue staging');
}
function resume(row) { process.kill(row.pid, 'SIGCONT'); stopped.delete(row.pid); }
async function indexes(db) {
    for (const m of [Receipts, Daily, Dashboards, State]) for (const [keys, options] of m.schema.indexes()) await db.collection(m.collection.name).createIndex(keys, options);
}
async function clearQueues() {
    const keys = [queue, processing, dead, globalLock, 'cron:ai-usage-backfills:queue', 'cron:ai-usage-backfills:processing', 'cron:ai-usage-backfills:dead'];
    for (const name of ['receipts', 'backfills']) keys.push(`ai-usage:queue-health:${name}`, `ai-usage:queue-health:${name}:snapshot`, `ai-usage:queue-health:${name}:alert`);
    await redis.del([...keys, ...redisKeys]); redisKeys.clear();
}
function track(raw) { redisKeys.add(`${queue}:attempts:${createHash('sha256').update(raw).digest('hex')}`); }
async function enqueue(raws, destination = queue) { for (const raw of raws) track(raw); if (raws.length) await redis.rPush(destination, raws); }
function accountLock(channelID, customerId) { return 'locks:ai-usage-write:' + createHash('sha256').update(JSON.stringify([channelID, customerId])).digest('hex'); }
function receipt(id, channelID = 'fixture-pro', extra = {}) {
    return { id, channelID, customerId: `customer-${channelID}`, requestId: null, occurredAt: new Date(now - 3600000).toISOString(),
        entryKind: 'usage', category: 'tts', operation: 'synthesize', source: 'fixture', provider: 'fixture', model: null,
        quantity: 10, unit: 'characters', credits: 4.5, resourceType: 'speech', resourceId: id, itemized: true,
        enqueuedAt: new Date(now).toISOString(), ...extra };
}
async function seedUsers(db) {
    for (const tier of ['free', 'premium', 'pro']) await db.collection(names.users).insertOne({ _id: new ObjectId(), plan_tier: tier,
        accounts: [{ type: 'twitch', id: `fixture-${tier}` }] });
}
async function dataRows(db, key) { return db.collection(names[key]).find().sort(key === 'receipts' ? { channelID: 1, entryId: 1 } : { channelID: 1, date: 1 }).toArray(); }
async function parity(left = actual, right = referenceDb) {
    for (const key of ['receipts', 'daily']) {
        const a = await dataRows(left, key), b = await dataRows(right, key);
        assert.deepEqual(a.map(stable), b.map(stable), `complete persisted ${key} accounting parity`);
        const fields = key === 'receipts' ? ['credits', 'quantity', 'occurredAt', 'expiresAt', 'created_at', 'updated_at']
            : ['spentCredits', 'grantedCredits', 'netConsumedCredits', 'transactionCount', 'dayStart', 'expiresAt', 'created_at', 'updated_at'];
        const projection = { _id: 0, channelID: 1, [key === 'receipts' ? 'entryId' : 'date']: 1,
            types: Object.fromEntries(fields.map(field => [field, { $type: `$${field}` }])) };
        const typeRows = db => db.collection(names[key]).aggregate([
            { $sort: key === 'receipts' ? { channelID: 1, entryId: 1 } : { channelID: 1, date: 1 } }, { $project: projection },
        ]).toArray();
        assert.deepEqual(await typeRows(left), await typeRows(right), `raw Mongo BSON type parity for ${key}, without JS promotion masking differences`);
        for (const doc of a) {
            for (const name of ['expiresAt', key === 'receipts' ? 'occurredAt' : 'dayStart']) assert(doc[name] instanceof Date, `${key}.${name} must remain BSON date`);
            for (const name of ['created_at', 'updated_at']) assert(doc[name] instanceof Date && +doc[name] >= now - 1000 && +doc[name] <= Date.now() + 1000);
            assert.equal(typeof doc[key === 'receipts' ? 'credits' : 'spentCredits'], 'number');
        }
    }
}
async function drained() { return Number(await redis.lLen(queue)) === 0 && Number(await redis.lLen(processing)) === 0; }
// This task-owned loopback proxy has one fixed upstream: the helper's isolated
// Mongo alias. It understands only uncompressed Mongo command frames and fails
// explicitly on any wire form it cannot inspect. Nothing is exposed on the host.
async function mongoHoldProxy(db, command, selectedCollection = names.receipts) {
    assert.match(db.databaseName, dbPattern); assert(owned.has(db.databaseName));
    assert([null, 'find', 'update'].includes(command));
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
                    if (!released && !held && name === command && body[name] === selectedCollection && database === db.databaseName) {
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
            assert(elapsed >= 18000 && elapsed < 28000);
            const frames = batchFrames(result.output); assert.equal(frames.length, 1);
            assert.equal(frames[0].success, false); assert.equal(frames[0].events, 0);
            assert.match(result.output, /AI usage active work timed out; leases retained for recovery/);
            assert(held && !released); assertWatchdogResetTiming(failures, result.exitedAt);
        },
        snapshot: () => ({ ...transport, held: Boolean(held), released, activeSockets: sockets.size }),
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
    return output.split('\n').filter(line => line.startsWith('ai_usage_receipts:'))
        .map(line => JSON.parse(line.slice('ai_usage_receipts:'.length)));
}
// Use stdout completion timestamps and remove the next pass's measured work.
// Each boundary is checked independently: aggregate throughput can hide sleeps.
function observeBatches(child) {
    const rows = []; let pending = '', failure;
    child.stdout.on('data', chunk => {
        try {
            pending += chunk; assert(pending.length <= 32768, 'continuous metadata buffer is bounded');
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) if (line.startsWith(protocol)) {
                const [frame] = batchFrames(line);
                assert.deepEqual(Object.keys(frame).sort(), ['durationMs', 'event', 'events', 'success']);
                assert.equal(frame.event, 'batch'); assert.equal(typeof frame.success, 'boolean');
                assert(Number.isInteger(frame.events) && frame.events >= 0 && frame.events <= 1000);
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
    assert.throws(() => assertReadyTransitions(synthetic([0, 1000, 0]), 'sleep control'), /ready transition 2 introduced 1000ms/);
    assert.throws(() => assertReadyTransitions(synthetic([700]), 'threshold control'), /introduced 700ms/);
    const paced = synthetic([1000]); assertPaced(...paced, 'paced control');
    assert.throws(() => assertPaced(...synthetic([0]), 'spin control'), /lost its one-second wait/);
}
function assertWatchdogResetTiming(errors, exitedAt) {
    assert(Number.isFinite(exitedAt));
    for (const error of errors) {
        assert.equal(error.kind, 'transport'); assert.equal(error.side, 'client'); assert.equal(error.code, 'ECONNRESET');
        assert.equal(error.clientEof, false); assert.equal(error.held, true); assert.equal(error.released, false);
        assert(Math.abs(error.at - exitedAt) <= 250, 'reset must coincide with independently confirmed watchdog exit');
    }
}
function verifyWatchdogResetClassification() {
    const reset = { kind: 'transport', side: 'client', code: 'ECONNRESET', clientEof: false, held: true, released: false, at: 1000 };
    assertWatchdogResetTiming([reset], 1001);
    for (const change of [{ at: 0 }, { side: 'upstream' }, { code: 'EPIPE' }, { kind: 'proxy' }, { clientEof: true }, { held: false }, { released: true }])
        assert.throws(() => assertWatchdogResetTiming([{ ...reset, ...change }], 1001));
}
async function stopContinuous(child, observation) {
    assert(child.kill('SIGTERM')); const result = await finished(child, 7000);
    observation.check(); assert.equal(result.code, 0, result.output); assert.equal(result.signal, null); return result;
}

async function redisRelay() {
    const sockets = new Set(); let closing = false;
    const stats = { accepted: 0, upstreamConnected: 0, downstreamClosed: 0, upstreamClosed: 0, requestBytes: 0, responseBytes: 0, drops: 0, errors: [] };
    const server = createServer(socket => {
        stats.accepted++;
        const upstream = createConnection({ host: 'redis', port: 6379 });
        upstream.once('connect', () => { stats.upstreamConnected++; });
        socket.on('data', chunk => { stats.requestBytes += chunk.length; }); upstream.on('data', chunk => { stats.responseBytes += chunk.length; });
        for (const [side, item] of [['downstream', socket], ['upstream', upstream]]) {
            sockets.add(item);
            item.on('error', error => { if (stats.errors.length < 8) stats.errors.push({ side, code: error.code || 'unknown' }); });
            item.on('close', () => { stats[`${side}Closed`]++; sockets.delete(item); socket.destroy(); upstream.destroy(); });
        }
        socket.pipe(upstream); upstream.pipe(socket);
    });
    const relay = { snapshot: () => ({ ...stats, activeSockets: sockets.size, listening: server.listening }), drop() { stats.drops++; for (const socket of sockets) socket.destroy(); }, async close() {
        if (closing) return; closing = true; relay.drop();
        if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), 3000, 'close Redis relay'); proxies.delete(relay);
    } };
    proxies.add(relay);
    await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); }), 3000, 'Redis relay listen');
    relay.port = String(server.address().port); return relay;
}
// Hold only global SET acquisition. The fixed Redis upstream and guarded DB
// belong to this disposable candidate. Redis commands must be RESP bulk arrays;
// unexpected forms or any post-signal queue operation fail explicitly.
async function redisAcquireProxy(db) {
    assert.match(db.databaseName, dbPattern); assert(owned.has(db.databaseName));
    const sockets = new Set(), commands = [];
    let failure, held, released = false, closing = false;
    const fail = error => {
        failure ||= error instanceof Error ? error : new Error(String(error));
        for (const socket of sockets) socket.destroy();
    };
    function request(buffer) {
        if (!buffer.length) return null;
        assert.equal(buffer[0], 42, 'Redis fixture expects RESP array command');
        let offset = buffer.indexOf('\r\n'); if (offset < 0) return null;
        const countText = buffer.toString('ascii', 1, offset); assert.match(countText, /^[0-9]+$/);
        const count = Number(countText); assert(count >= 1 && count <= 100, 'Redis fixture command argument bound');
        offset += 2; const args = [];
        for (let i = 0; i < count; i++) {
            if (offset >= buffer.length) return null;
            assert.equal(buffer[offset], 36, 'Redis fixture expects RESP bulk argument');
            const end = buffer.indexOf('\r\n', offset); if (end < 0) return null;
            const lengthText = buffer.toString('ascii', offset + 1, end); assert.match(lengthText, /^[0-9]+$/);
            const length = Number(lengthText); assert(length <= 1024 * 1024, 'Redis fixture argument bound');
            const start = end + 2; if (start + length + 2 > buffer.length) return null;
            assert.equal(buffer.toString('ascii', start + length, start + length + 2), '\r\n');
            args.push(buffer.toString('utf8', start, start + length)); offset = start + length + 2;
        }
        return { args, length: offset };
    }
    const server = createServer(downstream => {
        const upstream = createConnection({ host: 'redis', port: 6379 });
        for (const socket of [downstream, upstream]) {
            sockets.add(socket); socket.on('error', error => { if (!closing) fail(error); });
            socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
        }
        upstream.pipe(downstream);
        let pending = Buffer.alloc(0), blocked = false;
        const queued = [];
        downstream.on('data', chunk => {
            try {
                pending = Buffer.concat([pending, chunk]); assert(pending.length <= 1024 * 1024, 'Redis fixture input bound');
                for (;;) {
                    const parsed = request(pending); if (!parsed) break;
                    const packet = Buffer.from(pending.subarray(0, parsed.length)); pending = pending.subarray(parsed.length);
                    const [rawCommand, ...args] = parsed.args, command = rawCommand.toUpperCase(); commands.push({ command, args });
                    assert(['HELLO', 'CLIENT', 'PING', 'SET', 'EVAL'].includes(command), `Unexpected Redis acquire-boundary command ${command}`);
                    if (command === 'EVAL') {
                        const keys = args.slice(2, 2 + Number(args[1]));
                        assert(!keys.includes(processing) && !keys.includes(queue), 'SIGTERM after lease acquisition must not start reclaim/claim EVAL');
                        assert.equal(Number(args[1]), 1); assert.deepEqual(keys, [globalLock], 'only owned global lease release is permitted after signal');
                        assert(released, 'lease release must follow held acquisition');
                    }
                    if (command === 'SET') {
                        assert.equal(args[0], globalLock); assert(args.includes('NX') && args.includes('EX'), 'hold only global NX/EX lease acquisition');
                        assert(!held, 'one global acquisition expected'); blocked = true;
                        held = { release() {
                            if (released) return;
                            released = true; blocked = false;
                            upstream.write(packet); for (const next of queued) upstream.write(next); queued.length = 0;
                        } };
                    } else if (blocked) queued.push(packet);
                    else upstream.write(packet);
                }
            } catch (error) { fail(error); }
        });
    });
    server.on('error', fail);
    const proxy = {
        commands,
        check() { if (failure) throw failure; },
        async held() { return waitFor(() => { proxy.check(); return held; }, 'hold actual Redis global lease SET'); },
        release() { proxy.check(); assert(held); held.release(); },
        async close() {
            if (closing) return; closing = true;
            for (const socket of sockets) socket.destroy(); sockets.clear();
            if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), 3000, 'close acquire-boundary Redis relay');
            proxies.delete(proxy);
        },
    };
    proxies.add(proxy);
    await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); }), 3000, 'listen acquire-boundary Redis relay');
    const address = server.address(); assert(address && typeof address === 'object' && address.address === '127.0.0.1');
    proxy.port = String(address.port); return proxy;
}

async function assertNative(root, scope = 'main') {
    const rows = await records(scope), exited = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
    const alive = rows.filter(row => row.event === 'spawn' && row.native && row.supervisor === root && !exited.has(row.pid));
    assert.equal(alive.length, 1); const row = alive[0];
    assert.equal(row.command, binary); assert.equal(row.uid, 65534); assert.equal(row.gid, 65534);
    const allowed = ['MONGO_URI', 'PATH', 'TZ', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DRAGONFLY_HOST', 'DRAGONFLY_PORT',
        'AI_USAGE_RECEIPTS_INTERVAL_MS', 'AI_USAGE_RECEIPTS_BATCH_SIZE', 'AI_USAGE_RECEIPTS_LOCK_KEY', 'AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS', 'AI_USAGE_RECEIPTS_ENABLED',
        'AI_USAGE_QUEUE_MAX_AGE_SECONDS', 'AI_USAGE_PROCESSING_MAX_AGE_SECONDS', 'AI_USAGE_QUEUE_FAILURE_THRESHOLD'];
    assert(row.envKeys.includes('MONGO_URI') && row.envKeys.includes('DRAGONFLY_HOST'));
    assert(row.envKeys.every(key => allowed.includes(key)), 'native inherits only bounded Mongo/Redis/config environment');
    const status = await readFile(`/proc/${row.pid}/status`, 'utf8');
    assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m); assert.match(status, /^Gid:\s+65534\s+65534\s+65534\s+65534$/m);
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
        let cmd; try { cmd = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
        assert(!cmd.split('\0').some(arg => arg.endsWith('/ai_usage_receipts.worker.js')), 'no TypeScript receipt consumer alongside native');
    }
    for (const row of rows.filter(row => row.event === 'batch')) {
        assert.equal(row.frame.event, 'batch'); assert.equal(typeof row.frame.success, 'boolean');
        assert(Number.isInteger(row.frame.events) && row.frame.events >= 0 && row.frame.events <= 1000);
        assert(Number.isFinite(row.frame.durationMs) && row.frame.durationMs >= 0);
    }
}
async function telemetry() {
    const batches = (await redis.lRange('observability:v1:inbox', 0, -1)).map(JSON.parse); for (const batch of batches) validateBatch(batch);
    const metrics = batches.flatMap(batch => batch.metrics.map(metric => ({ ...metric, service: batch.service }))).filter(row => row.name.startsWith('ai_usage_receipts_rust.'));
    const allowed = ['rss_bytes', 'cpu_cores', 'batch_receipts', 'project_batch', 'errors', 'restarts'];
    for (const row of metrics) { assert(allowed.includes(row.name.slice('ai_usage_receipts_rust.'.length))); assert.equal(row.service, 'cron'); assert.equal(row.channel, ''); }
    const has = (name, check = () => true) => metrics.some(row => row.name === `ai_usage_receipts_rust.${name}` && check(row));
    return has('rss_bytes', row => row.kind === 'runtime' && row.max > 0) && has('cpu_cores', row => row.kind === 'runtime')
        && has('batch_receipts', row => row.kind === 'worker' && row.sum > 0) && has('project_batch', row => row.kind === 'queue_run' && row.outcome === 'ok')
        && has('errors', row => row.sum > 0) && has('restarts', row => row.sum > 0);
}
try {
    verifySchedulingAssertions(); verifyWatchdogResetClassification();
    await client.connect(); await redis.connect();
    const native = await waitFor(() => currentNative(), 'actual native default startup'), root = native.supervisor;
    await assertNative(root);
    const unrelated = (await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort();
    for (const worker of ['ai-usage-backfill', 'roulette-actions', 'roulette-completion', 'domain-events', 'stream-activity', 'raid-analytics', 'follow-defense-baseline']) assert(unrelated.includes(worker));
    let paused = await pause();
    await clearQueues(); await redis.set('ai-usage-fixture:unrelated', 'preserve');
    for (const db of [actual, referenceDb]) { await indexes(db); await seedUsers(db); }
    const inputs = [];
    for (const [tier, days] of [['free', 30], ['premium', 60], ['pro', 90]]) inputs.push({ tier, raw: JSON.stringify(receipt(`retention-${tier}`, `fixture-${tier}`, { occurredAt: new Date(now - (days - 1) * DAY).toISOString() })) });
    for (const [i, category] of ['tts', 'ai_chat', 'ai_agent', 'memory', 'clip_recommendation', 'other', 'uncategorized', 'credit_adjustment', 'invalid-category'].entries()) inputs.push({ tier: 'pro', raw: JSON.stringify(receipt(`category-${i}`, 'fixture-pro', { category, credits: i + 0.25 })) });
    for (const [i, extra] of [
        { credits: -12.75, source: 'free_credit_reset_worker' }, { entryKind: 'adjustment', credits: 3.25, operation: 'correction' },
        { entryKind: 'adjustment', credits: -9, source: 'admin_credit_grant' }, { entryKind: 'adjustment', credits: -8, operation: 'purchase_pack' },
        { entryKind: 'adjustment', credits: -7, source: 'polar_meter_credit' }, { entryKind: 'adjustment', credits: -6, operation: 'refund' },
        { entryKind: 'adjustment', credits: -5, source: 'activation' }, { entryKind: 'adjustment', credits: 2, adjustmentType: 'gifted_credits' },
        { credits: '12.5', quantity: '3', provider: '  provider  ', requestId: '  request  ' }, { credits: true, quantity: false },
        { credits: null, quantity: null }, { credits: '', quantity: '' }, { credits: '0x10', quantity: '1e2' },
        { credits: 1, quantity: undefined, source: '💡'.repeat(70), operation: 'x'.repeat(150) },
        { credits: 5, occurredAt: '2026-10-01T01:30:00+02:00', unit: 'invalid', resourceType: 'invalid', itemized: 'true' },
        { quantity: '9007199254740992' }, { quantity: '-9007199254740992' }, { quantity: '9007199254740993' },
        { quantity: 2147483648 }, { quantity: -2147483648 }, { quantity: [] }, { quantity: {}, credits: 0.125 },
    ].entries()) inputs.push({ tier: 'pro', raw: JSON.stringify(receipt(`edge-${i}`, 'fixture-pro', extra)) });
    inputs.push({ tier: 'free', raw: JSON.stringify(receipt('expired', 'fixture-free', { occurredAt: new Date(now - 31 * DAY).toISOString() })) });
    inputs.push({ tier: 'free', raw: JSON.stringify(receipt('fallback-free', 'fixture-unknown')) });
    const duplicateRaw = inputs[3].raw; inputs.push({ tier: 'pro', raw: duplicateRaw });
    const invalid = ['{invalid-json', 'null', JSON.stringify({ ...receipt('bad-date'), occurredAt: 'not-a-date' }), JSON.stringify({ ...receipt('bad-number'), credits: 'not-a-number' }), JSON.stringify({ ...receipt('bad-id'), id: '' })];
    await enqueue(inputs.map(row => row.raw));
    const baselineExit = await successOnce();
    assert.equal(batchFrames(baselineExit.output).at(-1).events, inputs.length);
    const expected = await reference(referenceDb, { mode: 'persist', receipts: inputs });
    assert(expected.some(row => row.status === 'duplicate')); assert(expected.some(row => row.status === 'expired'));
    await parity(); assert(await drained());
    await enqueue(invalid); const invalidExit = await successOnce();
    assert.equal(batchFrames(invalidExit.output).at(-1).success, false); assert.equal(batchFrames(invalidExit.output).at(-1).events, 0);
    assert.deepEqual(await redis.lRange(dead, 0, -1), invalid, 'invalid payloads retained exactly in dead letters');
    for (const [tier, days] of [['free', 30], ['premium', 60], ['pro', 90]]) {
        const doc = await actual.collection(names.receipts).findOne({ entryId: `retention-${tier}` });
        assert.equal(doc.retentionTier, tier); assert.equal(+doc.expiresAt - +doc.occurredAt, days * DAY);
    }
    const missingQuantity = await actual.collection(names.receipts).findOne({ entryId: 'edge-13' }); assert.equal(missingQuantity.quantity, null);
    const nullQuantity = await actual.collection(names.receipts).findOne({ entryId: 'edge-10' }); assert.equal(nullQuantity.quantity, 0);
    const bsonTypes = await actual.collection(names.receipts).aggregate([{ $match: { entryId: 'edge-0' } }, { $project: { _id: 0, at: { $type: '$occurredAt' }, expiry: { $type: '$expiresAt' }, credits: { $type: '$credits' }, quantity: { $type: '$quantity' } } }]).next();
    assert.deepEqual(bsonTypes, { at: 'date', expiry: 'date', credits: 'double', quantity: 'int' });
    console.log('PASS native/source TypeScript complete receipt/daily parity, parse/coercion/UTF16/date/category edges, signed adjustments, tier retention, malformed payload preservation and BSON types');

    await clearQueues();
    const parsedReplay = JSON.parse(duplicateRaw), original = await actual.collection(names.receipts).findOne({ entryId: parsedReplay.id });
    await actual.collection(names.daily).deleteMany({ channelID: parsedReplay.channelID, date: new Date(parsedReplay.occurredAt).toISOString().slice(0, 10) });
    await enqueue([duplicateRaw]); await delay(20); await successOnce();
    const updated = await actual.collection(names.receipts).findOne({ entryId: parsedReplay.id });
    assert(+updated.updated_at > +original.updated_at, 'duplicate updates Mongoose timestamp');
    assert.deepEqual(stable(updated), stable(original));
    await reference(referenceDb, { mode: 'persist', receipts: [{ raw: duplicateRaw, tier: 'pro' }] });
    await parity(); assert.equal(await redis.get(`twitch:${parsedReplay.channelID}:ai:usage-receipts:generation`), String(inputs.filter(row => JSON.parse(row.raw).channelID === parsedReplay.channelID).length + 1));
    const backfill = { mode: 'backfill', now: new Date(now).toISOString(), request: { channelID: parsedReplay.channelID, customerId: parsedReplay.customerId,
        planTier: 'pro', coverageStart: new Date(now - 89 * DAY).toISOString(), transactions: [parsedReplay] } };
    await enqueue([duplicateRaw]);
    const backfillProxy = await mongoHoldProxy(actual, 'update');
    const nativeConcurrent = launch(binary, ['--once', '--telemetry-json'], nativeEnv(actual, { MONGO_URI: backfillProxy.uri }), { uid: 65534, gid: 65534 });
    await backfillProxy.held();
    const referenceConcurrent = await startReference(actual, backfill);
    await waitFor(() => referenceConcurrent.output.includes('AI_USAGE_BACKFILL_START'), 'existing TS backfill reaches native-held writer lease');
    await delay(350); backfillProxy.check();
    assert.equal(referenceConcurrent.exitCode, null, 'backfill waits for native account writer');
    assert.equal(await actual.collection(names.state).countDocuments({ channelID: parsedReplay.channelID }), 0, 'backfill cannot publish coverage while native owns writer lock');
    backfillProxy.release();
    const [concurrentExit, backfillExit] = await Promise.all([finished(nativeConcurrent), finished(referenceConcurrent)]);
    assert.equal(concurrentExit.code, 0, concurrentExit.output); assert.equal(backfillExit.code, 0, backfillExit.output); await backfillProxy.close();
    await reference(referenceDb, backfill); await parity();
    console.log('PASS duplicate timestamp/aggregate crash repair, generation increments and concurrent existing TypeScript backfill serialize with native receipt writes without doubling');

    await clearQueues();
    const locked = receipt('writer-lock', 'fixture-pro');
    const lockHolder = await startReference(actual, { mode: 'hold-lock', channelID: locked.channelID, customerId: locked.customerId, holdMs: 1600 });
    await waitFor(() => lockHolder.output.includes('AI_USAGE_LOCK_HELD'), 'real TS account writer lock acquired');
    await enqueue([JSON.stringify(locked)]);
    const waiting = launch(binary, ['--once', '--telemetry-json'], nativeEnv(), { uid: 65534, gid: 65534 });
    await delay(350); assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: locked.id }), 0, 'native cannot bypass TS writer lock');
    assert.equal(waiting.exitCode, null); const holderExit = await finished(lockHolder); assert.equal(holderExit.code, 0, holderExit.output);
    const waitingExit = await finished(waiting); assert.equal(waitingExit.code, 0, waitingExit.output); assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: locked.id }), 1);
    assert.equal(await redis.exists(accountLock(locked.channelID, locked.customerId)), 0);
    await clearQueues();
    const heldRaw = JSON.stringify(receipt('global-lease-reclaim', 'fixture-free'));
    await enqueue([heldRaw], processing); await redis.set(globalLock, 'fixture-other-owner', { EX: 10 });
    const skipped = await successOnce(); assert.equal(batchFrames(skipped.output).at(-1).events, 0);
    assert.deepEqual(await redis.lRange(processing, 0, -1), [heldRaw]); assert.equal(await redis.get(globalLock), 'fixture-other-owner');
    await redis.del(globalLock); await successOnce(); assert(await drained()); assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'global-lease-reclaim' }), 1);
    console.log('PASS actual global lease excludes claim/reclaim, crash-owned processing payload reclaims exactly once, and native respects existing TS account writer lock');

    await clearQueues();
    const failedRaw = JSON.stringify(receipt('validator-poison', 'fixture-pro'));
    await actual.command({ collMod: names.receipts, validator: { entryId: { $ne: 'validator-poison' } }, validationLevel: 'strict', validationAction: 'error' });
    await enqueue([failedRaw]); const failed = await successOnce();
    assert.equal(batchFrames(failed.output).at(-1).events, 0); assert.equal(batchFrames(failed.output).at(-1).success, false);
    assert.deepEqual(await redis.lRange(dead, 0, -1), [failedRaw]); assert(await drained());
    assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'validator-poison' }), 0);
    assert.equal(await redis.hGet('ai-usage:queue-health:receipts', 'failures'), '3');
    await actual.command({ collMod: names.receipts, validator: {}, validationLevel: 'strict' });
    await enqueue([failedRaw]); await successOnce(); assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'validator-poison' }), 1);
    console.log('PASS actual Mongo validation errors retry three times, dead-letter the exact raw payload, release processing and recover after repair');

    await clearQueues();
    const expiredBurst = Array.from({ length: 1002 }, (_, n) => JSON.stringify(receipt(`expired-burst-${n}`, 'fixture-burst', { occurredAt: new Date(now - 31 * DAY).toISOString() })));
    await enqueue(expiredBurst); const burst = await successOnce(actual, { AI_USAGE_RECEIPTS_BATCH_SIZE: '1000' });
    assert.equal(batchFrames(burst.output).at(-1).events, 1000); assert.equal(await redis.lLen(queue), 2); assert.equal(await redis.lLen(dead), 0);
    await successOnce(); assert(await drained()); assert.equal(await redis.get('twitch:fixture-burst:ai:usage-receipts:generation'), '1002');
    assert.equal(await actual.collection(names.receipts).countDocuments({ channelID: 'fixture-burst' }), 0);
    console.log('PASS real 1002-job expired receipt burst respects native 1000 claimed-job cap, reports bounded successful telemetry, and drains remaining work without persisting expired receipts');
    await clearQueues();
    const schedulingDb = fixtureDatabase('scheduling'); await indexes(schedulingDb);
    const expiredJob = id => JSON.stringify(receipt(id, 'fixture-scheduling', { occurredAt: new Date(now - 31 * DAY).toISOString() }));
    await enqueue(Array.from({ length: 7 }, (_, n) => expiredJob(`ready-${n}`)));
    const schedule = launch(binary, ['--telemetry-json'], nativeEnv(schedulingDb, { AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const scheduleFrames = observeBatches(schedule);
    await waitFor(() => { scheduleFrames.check(); return scheduleFrames.rows.length >= 5; }, 'continuous three full receipt batches plus partial and idle');
    assert.deepEqual(scheduleFrames.rows.slice(0, 5).map(row => [row.success, row.events]), [[true, 2], [true, 2], [true, 2], [true, 1], [true, 0]]);
    assertReadyTransitions(scheduleFrames.rows.slice(0, 4), 'receipt ready burst');
    assertPaced(scheduleFrames.rows[3], scheduleFrames.rows[4], 'partial receipt batch');
    assert(await drained()); assert.equal(await redis.get('twitch:fixture-scheduling:ai:usage-receipts:generation'), '7');
    await stopContinuous(schedule, scheduleFrames);
    await enqueue(Array.from({ length: 6 }, (_, n) => expiredJob(`clean-full-${n}`)));
    const cleanFull = launch(binary, ['--telemetry-json'], nativeEnv(schedulingDb, { AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const cleanFrames = observeBatches(cleanFull);
    await waitFor(() => { cleanFrames.check(); return cleanFrames.rows.length >= 5; }, 'clean full batch reaches empty then paced idle');
    assert.deepEqual(cleanFrames.rows.slice(0, 5).map(row => [row.success, row.events]), [[true, 2], [true, 2], [true, 2], [true, 0], [true, 0]]);
    assertReadyTransitions(cleanFrames.rows.slice(0, 4), 'clean full receipt batches');
    assertPaced(cleanFrames.rows[3], cleanFrames.rows[4], 'empty receipt batch');
    await stopContinuous(cleanFull, cleanFrames); assert(await drained());
    assert.equal(await schedulingDb.collection(names.receipts).countDocuments(), 0, 'expired scheduling inputs remain unpersisted');
    console.log('PASS continuous three full receipt batches drain without injected waits, including clean full and partial tails; idle keeps default pacing and all expired generations acknowledge exactly once');

    await clearQueues();
    const scheduleInvalid = '{invalid-scheduling-json';
    await enqueue([expiredJob('before-error-0'), expiredJob('before-error-1'), scheduleInvalid, expiredJob('error-batch-good'), expiredJob('after-error')]);
    const failingSchedule = launch(binary, ['--telemetry-json'], nativeEnv(schedulingDb, { AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const failingFrames = observeBatches(failingSchedule);
    await waitFor(() => { failingFrames.check(); return failingFrames.rows.length >= 4; }, 'failure after full batch remains paced');
    assert.deepEqual(failingFrames.rows.slice(0, 4).map(row => [row.success, row.events]), [[true, 2], [false, 0], [true, 1], [true, 0]]);
    assertReadyTransitions(failingFrames.rows.slice(0, 2), 'full receipt batch before failure');
    assertPaced(failingFrames.rows[1], failingFrames.rows[2], 'failed full receipt batch');
    assertPaced(failingFrames.rows[2], failingFrames.rows[3], 'partial recovery receipt batch');
    await stopContinuous(failingSchedule, failingFrames);
    assert.deepEqual(await redis.lRange(dead, 0, -1), [scheduleInvalid]); assert(await drained());
    console.log('PASS continuous failure after an earlier full receipt batch reports unsuccessful zero events and keeps the interval despite a full claimed batch and ready tail');

    await clearQueues();
    const retryPoison = JSON.stringify(receipt('continuous-poison', 'fixture-scheduling-poison'));
    await schedulingDb.command({ collMod: names.receipts, validator: { entryId: { $ne: 'continuous-poison' } }, validationLevel: 'strict', validationAction: 'error' });
    await enqueue([retryPoison]);
    const poisonLoop = launch(binary, ['--telemetry-json'], nativeEnv(schedulingDb, { AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const poisonFrames = observeBatches(poisonLoop);
    await waitFor(() => { poisonFrames.check(); return poisonFrames.rows.length >= 3; }, 'requeued poison retries without a hot loop');
    assert.deepEqual(poisonFrames.rows.slice(0, 3).map(row => [row.success, row.events]), [[false, 0], [false, 0], [true, 0]]);
    assertPaced(poisonFrames.rows[0], poisonFrames.rows[1], 'requeued poison full batch');
    assertPaced(poisonFrames.rows[1], poisonFrames.rows[2], 'dead-letter poison partial batch');
    await stopContinuous(poisonLoop, poisonFrames);
    assert.deepEqual(await redis.lRange(dead, 0, -1), [retryPoison]); assert(await drained());
    assert.equal(await redis.hGet('ai-usage:queue-health:receipts', 'failures'), '3');
    assert.equal(await schedulingDb.collection(names.receipts).countDocuments(), 0);
    console.log('PASS continuous requeued poison remains paced, preserves original bytes through three failed attempts, dead-letters once, and never persists or spins');

    await clearQueues();
    const contentionRaw = expiredJob('lease-contended'); await enqueue([contentionRaw]);
    await redis.set(globalLock, 'fixture-continuous-owner', { EX: 30 });
    const contended = launch(binary, ['--telemetry-json'], nativeEnv(schedulingDb, { AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const contentionFrames = observeBatches(contended);
    await waitFor(() => { contentionFrames.check(); return contentionFrames.rows.length >= 3; }, 'contended global lease remains paced despite pending receipts');
    assert.deepEqual(contentionFrames.rows.slice(0, 3).map(row => [row.success, row.events]), [[true, 0], [true, 0], [true, 0]]);
    for (let n = 1; n < 3; n++) assertPaced(contentionFrames.rows[n - 1], contentionFrames.rows[n], 'contended global lease');
    assert.equal(await redis.get(globalLock), 'fixture-continuous-owner'); assert.deepEqual(await redis.lRange(queue, 0, -1), [contentionRaw]);
    await redis.del(globalLock); await waitFor(drained, 'contended receipt recovers after owner releases');
    await stopContinuous(contended, contentionFrames);
    console.log('PASS continuous global lease contention preserves queued payload and owner, waits at the default interval, and recovers after fixture release');
    await clearQueues();
    const dashboardChannel = 'fixture-dashboard', dashboardCustomer = 'customer-dashboard';
    const template = await actual.collection(names.receipts).findOne({ entryId: 'category-0' }); assert(template);
    const historyDocs = [1, 2, 3, 4].map(n => ({ ...clone(template), _id: new ObjectId(), channelID: dashboardChannel, customerId: dashboardCustomer,
        entryId: `completed-${n}`, credits: 100, occurredAt: new Date(dayEnd - n * DAY + 1000), expiresAt: new Date(now + DAY) }));
    const dashboardExtras = [
        ['today-spike', new Date(now), 10000, 'usage', null, 'ai_chat'],
        ['today-grant', new Date(now), -50, 'adjustment', 'monthly_reset', 'credit_adjustment'],
        ['today-debit', new Date(now), 7, 'adjustment', 'correction', 'credit_adjustment'],
        ['dst-before', new Date('2026-03-08T06:30:00Z'), 10, 'usage', null, 'memory'],
        ['dst-after', new Date('2026-03-08T07:30:00Z'), 10, 'usage', null, 'tts'],
    ].map(([entryId, occurredAt, credits, entryKind, adjustmentType, category]) => ({ ...clone(template), _id: new ObjectId(), channelID: dashboardChannel,
        customerId: dashboardCustomer, entryId, occurredAt, credits, entryKind, adjustmentType, category, expiresAt: new Date(now + DAY) }));
    const utcDays = Array.from({ length: 4 }, (_, n) => new Date(dayEnd - 3 * DAY + n * DAY).toISOString().slice(0, 10));
    const commonRequest = { channelID: dashboardChannel, customerId: dashboardCustomer, planTier: 'pro', accountCreatedAt: new Date(dayEnd - 3.5 * DAY).toISOString() };
    const dstRequest = { ...commonRequest, window: { from: '2026-03-07', to: '2026-03-09', timeZone: 'America/New_York',
        startTimestamp: '2026-03-07T05:00:00.000Z', endTimestampExclusive: '2026-03-10T04:00:00.000Z', days: ['2026-03-07', '2026-03-08', '2026-03-09'] } };
    const utcRequest = { ...commonRequest, window: { from: utcDays[0], to: utcDays.at(-1), timeZone: 'UTC',
        startTimestamp: new Date(dayEnd - 3 * DAY).toISOString(), endTimestampExclusive: new Date(dayEnd + DAY).toISOString(), days: utcDays } };
    const requests = [dstRequest, utcRequest, { ...utcRequest, accountCreatedAt: new Date(now).toISOString() }];
    const dashboardSeeds = requests.map((request, n) => ({ _id: new ObjectId(), key: `fixture-dashboard-${n}`, channelID: dashboardChannel, customerId: dashboardCustomer,
        planTier: 'pro', request, data: { fixtureStale: true }, dirty: n !== 0, refreshedAt: new Date(now - (n === 0 ? 120000 : 1000)),
        expiresAt: new Date(now + DAY), unrelated: { preserve: true }, __v: 0 }));
    const untouchedDashboard = { ...clone(dashboardSeeds[1]), _id: new ObjectId(), key: 'fixture-fresh-untouched', dirty: false, refreshedAt: new Date(), data: { preserve: 'fresh-data' } };
    for (const db of [actual, referenceDb]) {
        await db.collection(names.receipts).insertMany([...historyDocs, ...dashboardExtras].map(clone));
        await db.collection(names.state).insertOne({ channelID: dashboardChannel, customerId: dashboardCustomer, coverageStart: new Date(dayEnd - 4 * DAY), backfilledAt: new Date(now), reportVersion: 3 });
    }
    await actual.collection(names.dashboards).insertMany([...dashboardSeeds, untouchedDashboard].map(clone));
    const dashboardStarted = Date.now(); await successOnce();
    for (const [n, seed] of dashboardSeeds.entries()) {
        const actualDashboard = await actual.collection(names.dashboards).findOne({ _id: seed._id });
        const expectedDashboard = await reference(referenceDb, { mode: 'dashboard', request: seed.request, now: new Date(now).toISOString() });
        assert.deepEqual(normalize(actualDashboard.data), normalize(expectedDashboard), 'native dashboard data matches unchanged TS aggregates/history in every field');
        assert.equal(actualDashboard.dirty, false); assert(+actualDashboard.refreshedAt >= dashboardStarted && +actualDashboard.refreshedAt <= Date.now());
        const retained = { ...actualDashboard, data: seed.data, dirty: seed.dirty, refreshedAt: seed.refreshedAt };
        assert.deepEqual(normalize(retained), normalize(seed), 'refresh changes only data, dirty and refreshedAt');
        if (n < 2) { assert.equal(actualDashboard.data.history.averageDailyCredits, 100); assert.equal(actualDashboard.data.history.dayCount, 3); }
        if (n === 2) assert.equal(actualDashboard.data.history, null, 'no invented history when no completed covered UTC days exist');
        if (n === 0) assert.equal(actualDashboard.data.summary.daily[1].credits, 20, 'DST jump still groups both local hours into same day');
        if (n === 1) { assert.equal(actualDashboard.data.summary.totalSpentCredits, 10300); assert.equal(actualDashboard.data.summary.netConsumedCredits, 10257); }
    }
    assert.deepEqual(normalize(await actual.collection(names.dashboards).findOne({ _id: untouchedDashboard._id })), normalize(untouchedDashboard));
    console.log('PASS dirty/stale dashboard refresh exactly matches TS, preserves request/expiry/unrelated fields, handles DST/timezones/tied categories, and excludes today from completed UTC history with partial-day account floor');

    await clearQueues();
    const cachedDashboardSeed = { ...clone(dashboardSeeds[0]), _id: new ObjectId(), key: 'fixture-dirty-expired-replay', channelID: 'fixture-free', customerId: 'customer-fixture-free',
        request: { ...clone(utcRequest), channelID: 'fixture-free', customerId: 'customer-fixture-free', planTier: 'free' }, dirty: false, data: { preserveUntilMaintenance: true }, refreshedAt: new Date() };
    // A continuously running child has completed first maintenance before we
    // stage the replay. Its next receipt poll must dirty the snapshot before
    // the ten-second maintenance cadence is reached.
    const maintenanceProxy = await mongoHoldProxy(actual, null);
    const continuous = launch(binary, ['--telemetry-json'], nativeEnv(actual, { MONGO_URI: maintenanceProxy.uri, AI_USAGE_RECEIPTS_BATCH_SIZE: '2' }), { uid: 65534, gid: 65534 });
    const maintenanceFrames = observeBatches(continuous);
    const maintenanceQueries = () => maintenanceProxy.parsed.filter(row => row.name === 'find' && row.body.find === names.dashboards);
    await waitFor(() => { maintenanceFrames.check(); maintenanceProxy.check(); return maintenanceFrames.rows.length > 0; }, 'continuous worker initial maintenance');
    assert.equal(maintenanceQueries().length, 1);
    await actual.collection(names.dashboards).insertOne(cachedDashboardSeed);
    const freeReplay = inputs.find(row => row.tier === 'free' && JSON.parse(row.raw).id === 'retention-free').raw;
    const expiredReplay = inputs.find(row => JSON.parse(row.raw).id === 'expired').raw;
    await enqueue([freeReplay, expiredReplay]);
    await waitFor(async () => (await actual.collection(names.dashboards).findOne({ _id: cachedDashboardSeed._id }))?.dirty, 'duplicate and expired receipt invalidate dashboard');
    const dirtied = await actual.collection(names.dashboards).findOne({ _id: cachedDashboardSeed._id });
    assert.deepEqual(dirtied.data, cachedDashboardSeed.data); assert.equal(+dirtied.expiresAt, +cachedDashboardSeed.expiresAt);
    await waitFor(() => { maintenanceFrames.check(); return maintenanceFrames.rows.some(row => row.events === 2) && maintenanceFrames.rows.at(-1).events === 0; }, 'replay full batch completes before next staged burst');
    const priorMaintenanceFrames = maintenanceFrames.rows.length;
    await enqueue(Array.from({ length: 7 }, (_, n) => expiredJob(`maintenance-ready-${n}`)));
    await waitFor(() => { maintenanceFrames.check(); maintenanceProxy.check(); return maintenanceFrames.rows.slice(priorMaintenanceFrames).filter(row => row.events > 0).length >= 4; }, 'maintenance remains independent of rapid full receipt batches');
    const maintenanceBurst = maintenanceFrames.rows.slice(priorMaintenanceFrames).filter(row => row.events > 0).slice(0, 4);
    assert.deepEqual(maintenanceBurst.map(row => row.events), [2, 2, 2, 1]); assertReadyTransitions(maintenanceBurst, 'maintenance-ready burst');
    assert.equal(maintenanceQueries().length, 1, 'maintenance cannot run once per rapid batch');
    assert.equal((await actual.collection(names.dashboards).findOne({ _id: cachedDashboardSeed._id })).dirty, true);
    await waitFor(async () => {
        maintenanceFrames.check(); maintenanceProxy.check();
        return (await actual.collection(names.dashboards).findOne({ _id: cachedDashboardSeed._id }))?.dirty === false;
    }, 'ten-second maintenance eventually refreshes dirtied dashboard', 15000);
    assert.equal(maintenanceQueries().length, 2);
    assert(maintenanceQueries()[1].at - maintenanceQueries()[0].at >= 9500, 'ten-second cadence survives busy-loop continuation');
    await stopContinuous(continuous, maintenanceFrames); maintenanceProxy.check(); await maintenanceProxy.close();
    assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'expired' }), 0);
    await actual.collection(names.dashboards).deleteOne({ _id: cachedDashboardSeed._id });
    console.log('PASS duplicate/expired inputs dirty snapshots without overwriting data/expiry; rapid full batches preserve ten-second maintenance cadence and the later refresh completes');

    await clearQueues();
    const healthRaw = JSON.stringify({ id: 'fixture-health', enqueuedAt: new Date(now - 3600000).toISOString(), untouched: { original: true } });
    for (const [name, q, p, d] of [['receipts', queue, processing, dead], ['backfills', 'cron:ai-usage-backfills:queue', 'cron:ai-usage-backfills:processing', 'cron:ai-usage-backfills:dead']]) {
        await redis.rPush(q, healthRaw); await redis.rPush(p, healthRaw); await redis.rPush(d, healthRaw);
        await redis.hSet(`ai-usage:queue-health:${name}`, { processingSince: String(now - 3600000), pendingSince: String(now - 3600000), failures: '3', observedFailures: '0' });
    }
    await redis.set(globalLock, 'fixture-health-owner', { EX: 10 }); await successOnce();
    const healthSnapshots = [];
    for (const name of ['receipts', 'backfills']) {
        const snapshot = JSON.parse(await redis.get(`ai-usage:queue-health:${name}:snapshot`)); healthSnapshots.push(snapshot);
        for (const reason of ['queue_age', 'processing_stalled', 'dead_letters', 'repeated_failures']) assert(snapshot.reasons.includes(reason));
        assert.equal(snapshot.pending, 1); assert.equal(snapshot.processing, 1); assert.equal(snapshot.dead, 1);
        assert.equal(await redis.get(`ai-usage:queue-health:${name}:alert`), '1'); assert(await redis.ttl(`ai-usage:queue-health:${name}:snapshot`) > 0);
        await redis.hSet(`ai-usage:queue-health:${name}`, 'observedFailures', '0');
    }
    // Each status is computed at the same native sample time independently.
    for (const actualHealth of healthSnapshots) {
        await redis.hSet(`ai-usage:queue-health:${actualHealth.queue}`, 'observedFailures', '0');
        const expectedHealth = await reference(actual, { mode: 'health', now: +new Date(actualHealth.checkedAt) });
        assert.deepEqual(actualHealth, expectedHealth.find(row => row.queue === actualHealth.queue));
    }
    assert.deepEqual(await redis.lRange(processing, 0, -1), [healthRaw]);
    console.log('PASS native/source queue-health snapshots, both queue alerts, age/stall/dead-letter/failure reasons, TTL and lease-protected raw payload preservation');

    await clearQueues();
    const planChannel = 'fixture-plan-cache';
    await actual.collection(names.users).insertOne({ plan_tier: 'free', accounts: [{ type: 'twitch', id: planChannel }] });
    const planChild = launch(binary, ['--telemetry-json'], nativeEnv(), { uid: 65534, gid: 65534 });
    await enqueue([JSON.stringify(receipt('plan-before', planChannel))]);
    await waitFor(async () => await actual.collection(names.receipts).findOne({ entryId: 'plan-before' }), 'plan cache initial receipt');
    await actual.collection(names.users).updateOne({ 'accounts.id': planChannel }, { $set: { plan_tier: 'pro' } });
    await enqueue([JSON.stringify(receipt('plan-cached', planChannel))]);
    const cachedPlan = await waitFor(async () => await actual.collection(names.receipts).findOne({ entryId: 'plan-cached' }), 'plan cache reused'); assert.equal(cachedPlan.retentionTier, 'free');
    planChild.kill('SIGTERM'); const planExit = await finished(planChild); assert.equal(planExit.code, 0, planExit.output);
    await enqueue([JSON.stringify(receipt('plan-restarted', planChannel))]); await successOnce();
    assert.equal((await actual.collection(names.receipts).findOne({ entryId: 'plan-restarted' })).retentionTier, 'pro');
    console.log('PASS native plan cache retains tier across same-child polls and a new child reloads changed plan');

    await clearQueues();
    const reconnectDb = fixtureDatabase('reconnect'); await indexes(reconnectDb);
    const reconnectUri = new URL(uri); reconnectUri.pathname = `/${reconnectDb.databaseName}`;
    const reconnectReceipt = receipt('after-socket-drop', 'fixture-reconnect'), reconnectRaw = JSON.stringify(reconnectReceipt);
    const relay = await redisRelay();
    const reconnect = launch(process.execPath, ['/app/dist/workers/cron.index.js'], {
        ...process.env, MONGO_URI: reconnectUri.href, DRAGONFLY_HOST: '127.0.0.1', DRAGONFLY_PORT: relay.port,
        AI_USAGE_RECEIPTS_FIXTURE_SCOPE: 'reconnect',
    });
    try {
        const firstChild = await waitFor(() => currentNative('reconnect'), 'auxiliary reconnect supervisor native startup');
        const reconnectRoot = firstChild.supervisor;
        await waitFor(async () => (await records('reconnect')).some(row => row.event === 'batch' && row.pid === firstChild.pid && row.frame.success), 'supervised native Redis relay initial idle pass');
        await assertNative(reconnectRoot, 'reconnect');
        const siblingSpawns = rows => rows.filter(row => row.event === 'spawn' && !row.native).map(row => ({ worker: row.worker, pid: row.pid })).sort((a, b) => a.worker.localeCompare(b.worker));
        const initialSiblings = siblingSpawns(await records('reconnect'));
        // Keep the replacement from claiming before we inspect the exact raw
        // payload left by the failed connection. This is a fixture-owned lease.
        assert.equal(await redis.set(globalLock, 'fixture-reconnect-inspection', { NX: true, EX: 30 }), 'OK');
        relay.drop(); await enqueue([reconnectRaw]);
        await waitFor(async () => (await records('reconnect')).some(row => row.event === 'batch' && row.pid === firstChild.pid
            && row.frame.success === false && row.frame.events === 0), 'actual socket-loss failure frame');
        const failedExit = await waitFor(async () => (await records('reconnect')).find(row => row.event === 'exit' && row.pid === firstChild.pid), 'actual failed native exit after Redis socket loss');
        assert.equal(failedExit.code, 1); assert.equal(failedExit.signal, null);
        assert.deepEqual(await redis.lRange(queue, 0, -1), [reconnectRaw], 'failed acquire preserves the exact queued payload');
        assert.equal(await redis.lLen(processing), 0); assert.equal(await redis.lLen(dead), 0);
        const replacement = await waitFor(async () => { const row = await currentNative('reconnect'); return row && row.pid !== firstChild.pid ? row : null; }, 'supervisor replaces failed native Redis consumer');
        assert.equal(replacement.supervisor, reconnectRoot); assert.equal(reconnect.exitCode, null); assert.equal(reconnect.signalCode, null);
        assert.equal((await records('reconnect')).filter(row => row.event === 'spawn' && row.native).length, 2, 'exactly one bounded native restart');
        assert.deepEqual(siblingSpawns(await records('reconnect')), initialSiblings, 'socket loss never restarts other supervisor children');
        assert(relay.snapshot().accepted >= 2 && relay.snapshot().upstreamConnected >= 2 && relay.snapshot().listening, 'fixed Redis relay accepts fresh connections');
        assert.equal(await redis.get(globalLock), 'fixture-reconnect-inspection'); await redis.del(globalLock);
        await waitFor(async () => await reconnectDb.collection(names.receipts).findOne({ entryId: reconnectReceipt.id }), 'replacement persists preserved receipt');
        const generation = `twitch:${reconnectReceipt.channelID}:ai:usage-receipts:generation`;
        await waitFor(async () => await drained() && await redis.get(generation) === '1', 'replacement completes queue acknowledgement and generation exactly once');
        assert.equal(await reconnectDb.collection(names.receipts).countDocuments({ entryId: reconnectReceipt.id }), 1);
        const recoveredDaily = await reconnectDb.collection(names.daily).find({ channelID: reconnectReceipt.channelID }).toArray();
        assert.equal(recoveredDaily.length, 1); assert.equal(recoveredDaily[0].spentCredits, reconnectReceipt.credits); assert.equal(recoveredDaily[0].transactionCount, 1);
        const afterRecovery = (await records('reconnect')).filter(row => row.event === 'batch').length;
        await waitFor(async () => (await records('reconnect')).filter(row => row.event === 'batch').length >= afterRecovery + 2, 'replacement remains healthy through repeated polls');
        assert.equal(await redis.get(generation), '1'); assert.equal(await reconnectDb.collection(names.receipts).countDocuments({ entryId: reconnectReceipt.id }), 1);
        await assertNative(reconnectRoot, 'reconnect');
        assert.deepEqual(siblingSpawns(await records('reconnect')), initialSiblings);
        reconnect.kill('SIGTERM'); const reconnectExit = await finished(reconnect); assert.equal(reconnectExit.code, 0, reconnectExit.output); assert.equal(reconnectExit.signal, null);
        await waitFor(async () => (await records('reconnect')).some(row => row.event === 'exit' && row.pid === replacement.pid && row.code === 0 && row.signal === null), 'replacement gracefully exits with auxiliary supervisor');
        await delay(1100); assert.equal((await records('reconnect')).filter(row => row.event === 'spawn' && row.native).length, 2, 'shutdown adds no native restart');
        await relay.close();
    } catch (error) {
        console.error('AI_USAGE_RECONNECT_DIAGNOSTIC:' + JSON.stringify({
            exitCode: reconnect.exitCode, signalCode: reconnect.signalCode, output: reconnect.output.slice(-4000), relay: relay.snapshot(),
            nativeEvents: (await records('reconnect')).filter(row => row.native || row.event === 'batch').slice(-12),
            queue: await redis.lLen(queue), processing: await redis.lLen(processing), dead: await redis.lLen(dead),
            globalLeaseExists: await redis.exists(globalLock), globalLeaseTtl: await redis.ttl(globalLock),
        }));
        throw error;
    }
    console.log('PASS real Redis socket loss fails one native child, auxiliary supervisor alone restarts it, exact queued payload yields one receipt/day/generation, and graceful shutdown adds no restart');
    await clearQueues();
    const dailyPoison = JSON.stringify(receipt('daily-validator', 'fixture-daily-failure'));
    await actual.command({ collMod: names.daily, validator: { channelID: { $ne: 'fixture-daily-failure' } }, validationLevel: 'strict', validationAction: 'error' });
    await enqueue([dailyPoison]); await successOnce();
    assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'daily-validator' }), 1);
    assert.equal(await actual.collection(names.daily).countDocuments({ channelID: 'fixture-daily-failure' }), 0);
    assert.deepEqual(await redis.lRange(dead, 0, -1), [dailyPoison]);
    await actual.command({ collMod: names.daily, validator: {}, validationLevel: 'strict' });
    await enqueue([dailyPoison]); await successOnce();
    assert.equal(await actual.collection(names.receipts).countDocuments({ entryId: 'daily-validator' }), 1);
    assert.equal((await actual.collection(names.daily).findOne({ channelID: 'fixture-daily-failure' })).spentCredits, 4.5);
    console.log('PASS actual daily insert failure leaves one durable receipt and replay repairs missing aggregate without duplicate spend');

    await clearQueues();
    const faultDb = fixtureDatabase('faults'); await indexes(faultDb);
    const watchdogReceipt = receipt('watchdog-held', 'fixture-watchdog'), watchdogRaw = JSON.stringify(watchdogReceipt);
    await enqueue([watchdogRaw]);
    const watchdogProxy = await mongoHoldProxy(faultDb, 'update');
    const watchdogStarted = Date.now();
    const watchdog = launch(binary, ['--once', '--telemetry-json'], nativeEnv(faultDb, { MONGO_URI: watchdogProxy.uri }), { uid: 65534, gid: 65534 });
    await watchdogProxy.held();
    let watchdogExit;
    try {
        watchdogExit = await finished(watchdog, 28000);
        watchdogProxy.checkConfirmedWatchdogExit(watchdogExit, Date.now() - watchdogStarted);
    }
    catch (error) {
        console.error('AI_USAGE_WATCHDOG_PROXY_DIAGNOSTIC:' + JSON.stringify({
            transport: watchdogProxy.snapshot(), exitCode: watchdog.exitCode, signalCode: watchdog.signalCode, output: watchdog.output.slice(-4000),
        }));
        throw error;
    }
    assert.equal(watchdogProxy.snapshot().released, false, 'watchdog never forwards the held Mongo write');
    assert.notEqual(watchdogExit.code, 0, watchdogExit.output); assert.equal(watchdogExit.signal, null);
    const watchdogElapsed = Date.now() - watchdogStarted, watchdogFrames = batchFrames(watchdogExit.output);
    assert(watchdogElapsed >= 18000 && watchdogElapsed < 28000, `per-job watchdog ${watchdogElapsed}ms`);
    assert.equal(watchdogFrames.length, 1); assert.equal(watchdogFrames[0].success, false); assert.equal(watchdogFrames[0].events, 0);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: watchdogReceipt.id }), 0);
    assert.deepEqual(await redis.lRange(processing, 0, -1), [watchdogRaw]);
    const watchdogAccountLock = accountLock(watchdogReceipt.channelID, watchdogReceipt.customerId);
    assert(await redis.get(globalLock), 'hung unit retains global lease'); assert(await redis.get(watchdogAccountLock), 'hung unit retains writer lease');
    await watchdogProxy.close();
    // The child has exited. Accelerate only its private fixture leases instead
    // of waiting production TTLs or requeueing a possibly live operation.
    await redis.expire(globalLock, 1); await redis.expire(watchdogAccountLock, 1); await delay(1200);
    await successOnce(faultDb); assert(await drained());
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: watchdogReceipt.id }), 1);
    assert.equal((await faultDb.collection(names.daily).findOne({ channelID: watchdogReceipt.channelID })).spentCredits, watchdogReceipt.credits);
    console.log(`PASS actual ${watchdogElapsed}ms per-job watchdog preserves in-flight raw/global/account leases, exits nonzero and recovers exactly once after fixture lease expiry`);

    await clearQueues();
    const signalReceipt = receipt('signal-held', 'fixture-signal'), signalRaw = JSON.stringify(signalReceipt);
    const afterSignalRaws = Array.from({ length: 6 }, (_, n) => JSON.stringify(receipt(`signal-next-${n}`, 'fixture-signal-next')));
    await enqueue([signalRaw, ...afterSignalRaws]);
    const signalProxy = await mongoHoldProxy(faultDb, 'update');
    const signaled = launch(binary, ['--telemetry-json'], nativeEnv(faultDb, { MONGO_URI: signalProxy.uri }), { uid: 65534, gid: 65534 });
    await signalProxy.held(); assert(signaled.kill('SIGTERM')); await delay(350); signalProxy.check();
    assert.equal(signaled.exitCode, null); assert.equal(signaled.signalCode, null); process.kill(signaled.pid, 0);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: signalReceipt.id }), 0);
    signalProxy.release(); const signalExit = await finished(signaled, 7000); signalProxy.check();
    assert.equal(signalExit.code, 0, signalExit.output); assert.equal(signalExit.signal, null);
    const signalFrames = batchFrames(signalExit.output); assert.equal(signalFrames.length, 1); assert.equal(signalFrames[0].success, true); assert.equal(signalFrames[0].events, 1);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: signalReceipt.id }), 1);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ channelID: 'fixture-signal-next' }), 0);
    assert.deepEqual(await redis.lRange(queue, 0, -1), afterSignalRaws); assert.equal(await redis.lLen(processing), 0);
    assert.equal(await redis.exists(globalLock), 0); assert.equal(await redis.exists(accountLock(signalReceipt.channelID, signalReceipt.customerId)), 0);
    assert.equal(await redis.get(`twitch:${signalReceipt.channelID}:ai:usage-receipts:generation`), '1');
    await signalProxy.close();
    console.log('PASS SIGTERM during actual held receipt write drains receipt/day/ack/generation, releases owned leases, and starts no next job');

    await clearQueues();
    const acquireRaw = JSON.stringify(receipt('signal-acquire-processing', 'fixture-signal-acquire'));
    const acquireQueuedRaw = JSON.stringify(receipt('signal-acquire-queued', 'fixture-signal-acquire'));
    await enqueue([acquireRaw], processing); await enqueue([acquireQueuedRaw]);
    const acquireProxy = await redisAcquireProxy(faultDb);
    const acquiring = launch(binary, ['--telemetry-json'], nativeEnv(faultDb, { DRAGONFLY_HOST: '127.0.0.1', DRAGONFLY_PORT: acquireProxy.port }), { uid: 65534, gid: 65534 });
    await acquireProxy.held(); assert.equal(await redis.exists(globalLock), 0, 'held SET has not reached Redis');
    assert(acquiring.kill('SIGTERM')); await delay(350); acquireProxy.check();
    assert.equal(acquiring.exitCode, null); assert.equal(acquiring.signalCode, null);
    acquireProxy.release(); const acquireExit = await finished(acquiring, 5000); acquireProxy.check();
    assert.equal(acquireExit.code, 0, acquireExit.output); assert.equal(acquireExit.signal, null);
    const acquireFrames = batchFrames(acquireExit.output); assert.equal(acquireFrames.length, 1);
    assert.equal(acquireFrames[0].success, true); assert.equal(acquireFrames[0].events, 0);
    assert.equal(await redis.exists(globalLock), 0, 'acquired lease is released after pending SIGTERM');
    assert.deepEqual(await redis.lRange(processing, 0, -1), [acquireRaw], 'shutdown acquisition boundary never reclaims processing payload');
    assert.deepEqual(await redis.lRange(queue, 0, -1), [acquireQueuedRaw], 'shutdown starts no claim or next unit');
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: { $in: ['signal-acquire-processing', 'signal-acquire-queued'] } }), 0);
    assert.equal(acquireProxy.commands.filter(row => row.command === 'EVAL').length, 1, 'only bounded global release EVAL follows acquisition');
    await acquireProxy.close();
    console.log('PASS SIGTERM during held global SET acquisition releases the acquired lease and starts no reclaim, claim, maintenance or receipt write');

    await clearQueues();
    const lossReceipt = receipt('global-loss-current', 'fixture-lease-loss'), lossRaw = JSON.stringify(lossReceipt), lossNext = JSON.stringify(receipt('global-loss-next', 'fixture-lease-next'));
    await enqueue([lossRaw, lossNext]);
    const lossProxy = await mongoHoldProxy(faultDb, 'update');
    const loser = launch(binary, ['--telemetry-json'], nativeEnv(faultDb, { MONGO_URI: lossProxy.uri, AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS: '30', AI_USAGE_RECEIPTS_BATCH_SIZE: '1' }), { uid: 65534, gid: 65534 });
    const lossFrames = observeBatches(loser);
    await lossProxy.held();
    await redis.set(globalLock, 'fixture-replacement-global-owner', { EX: 30 });
    const lossAccountLock = accountLock(lossReceipt.channelID, lossReceipt.customerId);
    await redis.set(lossAccountLock, 'fixture-replacement-account-owner', { EX: 30 });
    await delay(10500); lossProxy.check(); lossProxy.release();
    await waitFor(() => { lossFrames.check(); lossProxy.check(); return lossFrames.rows.length >= 2; }, 'lost global lease forces wait before next contended batch', 7000);
    assert.deepEqual(lossFrames.rows.slice(0, 2).map(row => [row.success, row.events]), [[true, 1], [true, 0]]);
    assertPaced(lossFrames.rows[0], lossFrames.rows[1], 'lost global lease after full batch');
    await stopContinuous(loser, lossFrames); lossProxy.check();
    assert.equal(await redis.get(globalLock), 'fixture-replacement-global-owner'); assert.equal(await redis.get(lossAccountLock), 'fixture-replacement-account-owner');
    assert.deepEqual(await redis.lRange(queue, 0, -1), [lossNext]); assert.equal(await redis.lLen(processing), 0);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: lossReceipt.id }), 1);
    await lossProxy.close(); await redis.del([globalLock, lossAccountLock]); await successOnce(faultDb);
    assert(await drained()); assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: 'global-loss-next' }), 1);
    console.log('PASS actual global heartbeat detects lease loss, drains only the current full-batch unit, waits despite ready work, preserves replacement owners and recovers safely');

    await clearQueues();
    const earlyLoss = receipt('early-global-loss', 'fixture-early-lease-loss');
    const earlyNext = JSON.stringify(receipt('early-global-loss-next', 'fixture-early-lease-next'));
    await enqueue([JSON.stringify(earlyLoss), earlyNext]);
    const earlyProxy = await mongoHoldProxy(faultDb, 'update');
    const earlyChild = launch(binary, ['--telemetry-json'], nativeEnv(faultDb, { MONGO_URI: earlyProxy.uri, AI_USAGE_RECEIPTS_LOCK_TTL_SECONDS: '30', AI_USAGE_RECEIPTS_BATCH_SIZE: '1' }), { uid: 65534, gid: 65534 });
    const earlyFrames = observeBatches(earlyChild); const earlyHeld = await earlyProxy.held();
    await redis.set(globalLock, 'fixture-early-replacement', { EX: 30 });
    const earlyAccount = accountLock(earlyLoss.channelID, earlyLoss.customerId);
    await redis.set(earlyAccount, 'fixture-early-account-replacement', { EX: 30 });
    assert(Date.now() - earlyHeld.at < 2000, 'ownership replacement must precede the ten-second heartbeat');
    earlyProxy.release();
    await waitFor(() => { earlyFrames.check(); earlyProxy.check(); return earlyFrames.rows.length >= 2; }, 'release-owner check paces full batch before heartbeat can notice replacement', 7000);
    assert.deepEqual(earlyFrames.rows.slice(0, 2).map(row => [row.success, row.events]), [[true, 1], [true, 0]]);
    assertPaced(earlyFrames.rows[0], earlyFrames.rows[1], 'lease release ownership loss before heartbeat');
    await stopContinuous(earlyChild, earlyFrames); earlyProxy.check(); await earlyProxy.close();
    assert.equal(await redis.get(globalLock), 'fixture-early-replacement'); assert.equal(await redis.get(earlyAccount), 'fixture-early-account-replacement');
    assert.deepEqual(await redis.lRange(queue, 0, -1), [earlyNext]); assert.equal(await redis.lLen(processing), 0);
    assert.equal(await faultDb.collection(names.receipts).countDocuments({ entryId: earlyLoss.id }), 1);
    await redis.del([globalLock, earlyAccount]); await successOnce(faultDb); assert(await drained());
    console.log('PASS a replaced lease before heartbeat is independently detected by owned release, keeps full-batch scheduling paced, preserves replacement owners and retains the ready tail');

    await clearQueues();
    const invalidCli = await finished(launch(binary, ['--invalid-fixture-flag'], nativeEnv())); assert.notEqual(invalidCli.code, 0);
    const noEnv = await finished(launch(binary, ['--once'], { PATH: process.env.PATH })); assert.notEqual(noEnv.code, 0);
    const dry = await once(actual, { MONGO_URI: 'mongodb://127.0.0.1:1/ai_usage_receipts_fixture_unused' }, ['--dry-run', '--env-file', '/does-not-exist']); assert.equal(dry.code, 0, dry.output);
    await enqueue([JSON.stringify(receipt('disabled-job', 'fixture-disabled'))]); const disabled = await once(actual, { AI_USAGE_RECEIPTS_ENABLED: 'false' }); assert.equal(disabled.code, 0, disabled.output); assert.equal(await redis.lLen(queue), 1);
    await clearQueues();
    console.log('PASS strict CLI validation, missing environment, no-connection dry run and disabled consumer leave queued work untouched');

    const killed = paused; stopped.delete(killed.pid); process.kill(killed.pid, 'SIGKILL');
    const replacement = await waitFor(async () => { const row = await currentNative(); return row && row.pid !== killed.pid ? row : null; }, 'only native AI usage child restarts');
    assert.equal(replacement.supervisor, root); await assertNative(root);
    assert.deepEqual((await records()).filter(row => row.event === 'spawn' && !row.native).map(row => row.worker).sort(), unrelated);
    await enqueue([JSON.stringify(receipt('after-supervisor-restart', 'fixture-pro'))]);
    await waitFor(async () => await actual.collection(names.receipts).findOne({ entryId: 'after-supervisor-restart' }), 'replacement actually persists');
    await waitFor(telemetry, 'analytics-valid actual native runtime/receipt/error/restart Redis metrics', 35000);
    paused = await pause();
    console.log('PASS SIGKILL restarts only actual native AI usage consumer, replacement persists real work, and restricted native metrics reach analytics-valid Redis envelopes');

    await clearQueues();
    const shutdownDb = fixtureDatabase('shutdown'), shutdownUri = new URL(uri); shutdownUri.pathname = `/${shutdownDb.databaseName}`;
    const auxiliary = launch(process.execPath, ['/app/dist/workers/cron.index.js'], { ...process.env, MONGO_URI: shutdownUri.href, AI_USAGE_RECEIPTS_FIXTURE_SCOPE: 'shutdown' });
    const ownedChild = await waitFor(() => currentNative('shutdown'), 'auxiliary native startup');
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'batch' && row.frame.success), 'auxiliary native maintenance');
    auxiliary.kill('SIGTERM'); const shutdownExit = await finished(auxiliary); assert.equal(shutdownExit.code, 0, shutdownExit.output);
    await waitFor(async () => (await records('shutdown')).some(row => row.event === 'exit' && row.pid === ownedChild.pid && row.code === 0 && row.signal === null), 'native child graceful auxiliary exit');
    await delay(1100); assert.equal((await records('shutdown')).filter(row => row.event === 'spawn' && row.native).length, 1);
    assert.equal(await redis.get('ai-usage-fixture:unrelated'), 'preserve', 'fixture setup never flushes unrelated Redis keys');
    resume(paused);
    console.log('PASS actual auxiliary supervisor graceful shutdown without native restart and fixture-scoped cleanup preserves unrelated Redis data');
} finally {
    await Promise.allSettled([...proxies].map(proxy => proxy.close()));
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.allSettled([...children].map(async child => {
        try { await bounded(child.completion, 5000, 'cleanup SIGTERM'); }
        catch { try { child.kill('SIGKILL'); } catch {} await bounded(child.completion.catch(() => {}), 2000, 'cleanup SIGKILL').catch(() => {}); }
    }));
    await Promise.allSettled([...files].map(file => unlink(file)));
    try { for (const name of owned) { assert.match(name, dbPattern); await client.db(name).dropDatabase(); } }
    finally { await bounded(client.close(), 5000, 'client close').catch(() => {}); if (redis.isOpen) redis.destroy(); }
}
