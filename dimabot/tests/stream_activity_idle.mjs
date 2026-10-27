#!/usr/bin/env node
// Fixture only: cargo build --locked --release --bin stream_activity
// STREAM_ACTIVITY_TEST_URI=... node tests/stream_activity_idle.mjs [binary-path]
// Enables profiling only on task-owned databases; no application env files loaded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const uri = process.env.STREAM_ACTIVITY_TEST_URI;
if (!uri) throw new Error('STREAM_ACTIVITY_TEST_URI must explicitly name a disposable MongoDB fixture');
const require = createRequire(new URL('../package.json', import.meta.url));
const { MongoClient, ObjectId } = require('mongodb');
const binary = path.resolve(process.argv[2] || fileURLToPath(new URL('../target/release/stream_activity', import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), 'stream-activity-idle-'));
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
const owned = new Set(), children = new Set();
const observedQueries = new Map();
const prefix = `stream_activity_fixture_idle_${process.pid}_`;
const pendingFilter = { op: 'query', 'command.find': 'stream_activities', 'command.filter.processed': false };

function fixtureUri(database) {
    const parsed = new URL(uri);
    if (parsed.username && !parsed.searchParams.has('authSource')) parsed.searchParams.set('authSource', decodeURIComponent(parsed.pathname.slice(1)) || 'admin');
    parsed.pathname = `/${database}`;
    return parsed.href;
}
function database(label) {
    const name = `${prefix}${label}`;
    assert.match(name, /^stream_activity_fixture_idle_[a-zA-Z0-9_]+$/);
    assert(Buffer.byteLength(name) <= 63, 'fixture database name must fit MongoDB limit');
    owned.add(name);
    return client.db(name);
}
async function profilePending(db) {
    assert(owned.has(db.databaseName) && db.databaseName.startsWith(prefix));
    await db.createCollection('stream_activities');
    // Level 2 ignores filter and profiles even system.profile reads, eventually
    // evicting the operations under test from its capped collection. Level 1
    // with a filter captures matching operations regardless of their duration.
    // https://www.mongodb.com/docs/manual/reference/command/profile/
    const filter = { ns: `${db.databaseName}.stream_activities`, ...pendingFilter };
    await db.command({ profile: 1, filter });
    const status = await db.command({ profile: -1 });
    assert.equal(status.was, 1, 'fixture profiling must honor its filter');
    // MongoDB canonicalizes the expression (for example, explicit $and/$eq).
    // The final profile assertions check which operations actually matched it.
    assert(status.filter && typeof status.filter === 'object', 'fixture profiling must retain a filter');
}
function launch(db) {
    const child = spawn(binary, [], {
        cwd: temporary, env: { ...process.env, MONGO_URI: fixtureUri(db.databaseName) },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.fixtureOutput = () => ({ stdout: stdout.slice(-2048), stderr: stderr.slice(-2048) });
    child.fixtureCompletion = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }, 40000);
        child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer); children.delete(child);
            if (timedOut) reject(new Error('Idle CLI fixture exceeded 40 seconds'));
            else resolve({ code, signal, stdout, stderr });
        });
    });
    child.fixtureCompletion.catch(() => {});
    return child;
}
async function pendingQueries(db, count, child, timeout = 9000) {
    const deadline = Date.now() + timeout;
    const observed = observedQueries.get(db.databaseName) || new Map();
    observedQueries.set(db.databaseName, observed);
    for (;;) {
        const rows = await db.collection('system.profile').find(pendingFilter).sort({ ts: 1 }).toArray();
        for (const row of rows) {
            // system.profile may omit _id. The timestamp, session, query and
            // result identify these serial pending finds across repeated reads.
            const identity = row._id?.toString() || JSON.stringify([
                row.ts, row.command?.lsid, row.op, row.ns, row.command?.filter, row.nreturned,
            ]);
            observed.set(identity, row);
        }
        const queries = [...observed.values()].sort((left, right) => left.ts - right.ts);
        if (queries.length >= count) return queries;
        if (!children.has(child) || Date.now() >= deadline) {
            await diagnostics(db, child, count, queries.length);
            assert(children.has(child), 'continuous worker exited before the expected pending query');
            assert.fail(`missing pending query ${count}`);
        }
        await delay(25);
    }
}
async function diagnostics(db, child, expected, observed) {
    assert(owned.has(db.databaseName) && db.databaseName.startsWith(prefix));
    const rows = await db.collection('system.profile').find().sort({ ts: -1 }).limit(1000).toArray();
    const summary = rows.filter(row => row.command?.filter?._id !== 'fixture-idle-message')
        .slice(0, 50).reverse().map(row => ({
            ts: row.ts, op: row.op, find: row.command?.find,
            filter: row.command?.filter, nreturned: row.nreturned,
        }));
    const state = await db.collection('stream_activity_states').findOne({ _id: 'projector-v1' });
    console.error('Idle fixture diagnostics', JSON.stringify({
        database: db.databaseName, expected, observed, profile: summary,
        checkpoint: state && { seq: state.seq, active: state.active, leaseUntil: state.leaseUntil },
        child: { running: children.has(child), ...child.fixtureOutput() },
    }));
}
async function assertOnlyPendingProfile(db) {
    const rows = await db.collection('system.profile').find().toArray();
    assert(rows.length > 0, 'fixture must record pending queries');
    for (const row of rows) {
        assert.equal(row.ns, `${db.databaseName}.stream_activities`, 'profiler must exclude its own reads and other namespaces');
        assert.equal(row.op, 'query');
        assert.equal(row.command?.find, 'stream_activities');
        assert.equal(row.command?.filter?.processed, false);
    }
}
function elapsed(earlier, later) { return later.ts.getTime() - earlier.ts.getTime(); }
function expectDelay(actual, expected, label) {
    // Scheduling and DB work can add latency. The floor rejects a shorter
    // backoff tier; three seconds of upper jitter tolerates a busy shared host.
    assert(actual >= expected - 200 && actual <= expected + 3000,
        `${label}: expected approximately ${expected}ms, observed ${actual}ms`);
}
async function stop(child, signal) {
    const started = Date.now();
    assert(child.kill(signal), `worker must accept ${signal}`);
    const result = await child.fixtureCompletion;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert(Date.now() - started < 3000, `${signal} must interrupt the idle wait within three seconds`);
}

try {
    await client.connect();
    const main = database('poll'), shutdown = database('shutdown');
    await profilePending(main);
    await profilePending(shutdown);
    const child = launch(main), capChild = launch(shutdown);
    // The shutdown process reaches its first capped wait while the main worker
    // continues to a second capped query, keeping the whole test around 23s.
    const capShutdown = (async () => {
        const queries = await pendingQueries(shutdown, 5, capChild, 22000);
        expectDelay(elapsed(queries[3], queries[4]), 5000, 'shutdown worker reached cap');
        await stop(capChild, 'SIGINT');
    })();
    capShutdown.catch(() => {});
    let queries = await pendingQueries(main, 6, child, 28000);
    const expected = [1000, 2000, 4000, 5000, 5000];
    for (let index = 0; index < expected.length; index++) {
        assert.equal(queries[index].nreturned, 0, 'idle pending query must return no activities');
        expectDelay(elapsed(queries[index], queries[index + 1]), expected[index], `idle tier ${index + 1}`);
    }
    assert.equal(queries[5].nreturned, 0);
    console.log('PASS pending query timestamps show 1s, 2s, 4s, 5s, 5s idle waits');
    const insertedAt = Date.now();
    await main.collection('stream_activities').insertOne({
        _id: 'fixture-idle-message', channelID: 'fixture-idle',
        session_id: new ObjectId('0123456789abcdef01234567'),
        occurredAt: new Date('2100-01-01'), expiresAt: new Date('2101-01-01'),
        kind: 'message', actor: 'fixture-actor', emotes: [], processed: false,
    });
    const processingDeadline = insertedAt + 8000;
    for (;;) {
        if ((await main.collection('stream_activities').findOne({ _id: 'fixture-idle-message' })).processed) break;
        assert(children.has(child) && Date.now() < processingDeadline,
            'new work must be processed within the 5s cap plus 3s allowance');
        await delay(25);
    }
    assert(Date.now() <= processingDeadline, 'processing must complete within the capped polling allowance');
    queries = await pendingQueries(main, 9, child);
    assert.equal(queries[6].nreturned, 1, 'first capped poll after insertion must see the activity');
    assert(queries[6].ts.getTime() - insertedAt <= 8000, 'new work must be discovered within the 5s cap plus 3s allowance');
    assert.equal((await main.collection('stream_activities').findOne({ _id: 'fixture-idle-message' })).processed, true);
    assert.equal(queries[7].nreturned, 0);
    assert(elapsed(queries[6], queries[7]) < 1000, 'work must trigger the next pending query immediately without an idle sleep');
    assert.equal(queries[8].nreturned, 0);
    expectDelay(elapsed(queries[7], queries[8]), 1000, 'first empty poll after work resets to 1s');
    console.log('PASS capped polling discovers inserted work, immediately drains backlog, then resets idle polling to 1s');
    await stop(child, 'SIGTERM');
    await capShutdown;
    await assertOnlyPendingProfile(main);
    await assertOnlyPendingProfile(shutdown);
    console.log('PASS SIGINT interrupts a capped 5s wait and SIGTERM interrupts the reset idle wait');
} finally {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await Promise.allSettled([...children].map(child => child.fixtureCompletion));
    try {
        let cleanupFailure;
        for (const name of owned) {
            assert(name.startsWith(prefix));
            const db = client.db(name);
            // Disable task-owned profiling before removing its database.
            try { await db.command({ profile: 0 }); } catch (error) { cleanupFailure ??= error; }
            try { await db.dropDatabase(); } catch (error) { cleanupFailure ??= error; }
        }
        if (cleanupFailure) throw cleanupFailure;
    } finally {
        await client.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
