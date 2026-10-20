#!/usr/bin/env node
// Fixture only: cargo build --locked --release --bin stream_activity
// STREAM_ACTIVITY_TEST_URI=... node tests/stream_activity_cli.mjs [binary-path]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const uri = process.env.STREAM_ACTIVITY_TEST_URI;
if (!uri) throw new Error('STREAM_ACTIVITY_TEST_URI must explicitly name a disposable MongoDB fixture');
const require = createRequire(new URL('../../dimabot/package.json', import.meta.url));
const { MongoClient, ObjectId } = require('mongodb');
const binary = path.resolve(process.argv[2] || fileURLToPath(new URL('../target/release/stream_activity', import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), 'stream-activity-cli-'));
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
const owned = new Set(), children = new Set();
const prefix = `stream_activity_fixture_cli_${process.pid}_`;
const missingFile = path.join(temporary, 'missing.env');
const badFile = path.join(temporary, 'bad.env');

function fixtureUri(database = '') {
    const parsed = new URL(uri);
    if (parsed.username && !parsed.searchParams.has('authSource')) parsed.searchParams.set('authSource', decodeURIComponent(parsed.pathname.slice(1)) || 'admin');
    parsed.pathname = `/${database}`;
    return parsed.href;
}
function database(label) {
    const name = `${prefix}${label}`;
    assert.match(name, /^stream_activity_fixture_[a-zA-Z0-9_]+$/);
    assert(Buffer.byteLength(name) <= 63, 'fixture database name must fit MongoDB limit');
    owned.add(name);
    return client.db(name);
}
async function seed(db) {
    await db.collection('stream_activities').insertOne({ _id: 'fixture-cli-message', channelID: 'fixture-cli',
        session_id: new ObjectId('0123456789abcdef01234567'), occurredAt: new Date('2100-01-01'),
        expiresAt: new Date('2101-01-01'), kind: 'message', actor: 'fixture-actor', emotes: [], processed: false });
}
function launch(args, mongo) {
    const env = { ...process.env };
    delete env.MONGO_URI;
    if (mongo !== undefined) env.MONGO_URI = mongo;
    const child = spawn(binary, args, { cwd: temporary, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let timedOut = false;
    const completion = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 15000);
        child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer); children.delete(child);
            if (timedOut) reject(new Error('CLI fixture process exceeded 15 seconds'));
            else resolve({ code, signal, stdout, stderr });
        });
    });
    // The caller may inspect fixture readiness before awaiting shutdown.
    completion.catch(() => {});
    child.fixtureCompletion = completion;
    return { child, completion };
}
async function run(args, mongo) { return launch(args, mongo).completion; }
async function success(args, mongo) {
    const result = await run(args, mongo);
    assert.equal(result.code, 0, result.stderr);
    return result;
}
async function projected(db) {
    assert.equal((await db.collection('stream_activities').findOne()).processed, true);
    const state = await db.collection('stream_activity_states').findOne({ _id: 'projector-v1' });
    assert.equal(state.seq, 1);
    assert.equal(state.active, undefined);
    assert.equal((await db.collection('stream_activity_aggregates').findOne({ scope: 'summary' })).messages, 1);
}

try {
    await writeFile(badFile, 'MONGO_URI=not-a-mongodb-uri\n', { mode: 0o600 });
    assert.match((await success(['--help', '--env-file', missingFile])).stdout, /Usage: stream_activity/);
    assert.match((await success(['--dry-run', '--env-file', missingFile])).stdout, /no connection or environment files loaded/);
    console.log('PASS help/dry-run need neither MONGO_URI nor a readable selected environment file');
    await client.connect();
    const fromFile = database('from_file');
    await seed(fromFile);
    const goodFile = path.join(temporary, 'selected.env');
    await writeFile(goodFile, `MONGO_URI=${JSON.stringify(fixtureUri(fromFile.databaseName))}\n`, { mode: 0o600 });
    await success(['--once', '--env-file', goodFile]);
    await projected(fromFile);
    const fromEnvironment = database('from_environment');
    await seed(fromEnvironment);
    await success(['--once', '--env-file', badFile], fixtureUri(fromEnvironment.databaseName));
    await projected(fromEnvironment);
    const ignored = database('uri_default'), overridden = database('override');
    await seed(ignored); await seed(overridden);
    await success(['--once', '--database', overridden.databaseName], fixtureUri(ignored.databaseName));
    await projected(overridden);
    assert.equal((await ignored.collection('stream_activities').findOne()).processed, false);
    assert.equal(await ignored.collection('stream_activity_states').countDocuments(), 0);
    console.log('PASS selected env file, environment precedence, URI database and explicit --database override');
    const missingDatabase = await run(['--once'], fixtureUri());
    assert.notEqual(missingDatabase.code, 0);
    assert.match(missingDatabase.stderr, /Select a database using --database or MONGO_URI/);
    const missingEnvironment = await run(['--once', '--env-file', missingFile], fixtureUri(fromFile.databaseName));
    assert.notEqual(missingEnvironment.code, 0);
    assert.match(missingEnvironment.stderr, /Cannot load selected environment file/);
    console.log('PASS actionable missing-database and missing-selected-file failures');
    for (const signal of ['SIGTERM', 'SIGINT']) {
        const db = database(signal.toLowerCase());
        const { child, completion } = launch([], fixtureUri(db.databaseName));
        const deadline = Date.now() + 8000;
        for (;;) {
            if (await db.collection('stream_activity_states').findOne({ _id: 'projector-v1', owner: { $exists: true }, leaseUntil: { $lte: new Date() } })) break;
            assert(Date.now() < deadline && children.has(child), 'continuous CLI must become idle before signal');
            await delay(25);
        }
        const started = Date.now();
        child.kill(signal);
        const result = await completion;
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert(Date.now() - started < 3000, 'idle shutdown must finish within three seconds');
    }
    console.log('PASS continuous idle process exits successfully and promptly on SIGTERM and SIGINT');
} finally {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await Promise.allSettled([...children].map(child => child.fixtureCompletion));
    try {
        for (const name of owned) {
            assert(name.startsWith(prefix));
            await client.db(name).dropDatabase();
        }
    } finally {
        await client.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
