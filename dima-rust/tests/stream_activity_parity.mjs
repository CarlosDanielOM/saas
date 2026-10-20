#!/usr/bin/env node
// Run only against a disposable MongoDB 8.2+ fixture with TTL monitoring disabled.
// STREAM_ACTIVITY_TEST_URI=... node tests/stream_activity_parity.mjs [--benchmark]
// Build the release driver first: cargo build --locked --release --example stream_activity_fixture
// The reference is compiled from exactly three source modules, without app bootstrap/telemetry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { streamActivityFixtures, benchmarkFixtures } from './fixtures/stream_activity.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(new URL('../../dimabot/package.json', import.meta.url));
const prefix = 'stream_activity_fixture_';
const uri = process.env.STREAM_ACTIVITY_TEST_URI;
if (!uri) throw new Error('STREAM_ACTIVITY_TEST_URI is required; use only a disposable MongoDB fixture');
const script = fileURLToPath(import.meta.url);
const collectionNames = ['stream_activities', 'stream_activity_aggregates', 'stream_activity_states'];
const dashboardState = { _id: 'dashboard-projector-v1', seq: 42, owner: 'fixture-dashboard-owner',
    leaseUntil: new Date('2100-01-01'), marker: 'must remain untouched' };

function assertDatabase(name) {
    assert.match(name, /^stream_activity_fixture_[a-zA-Z0-9_]+$/, 'fixture-only database prefix required');
    return name;
}

async function referenceModules(directory) {
    const mongoose = (await import(pathToFileURL(path.join(directory, 'node_modules/mongoose/index.js')).href)).default;
    mongoose.set('autoIndex', false);
    const schemas = await import(pathToFileURL(path.join(directory, 'schemas/stream_activity.schema.js')).href);
    const { projectStreamActivityBatch } = await import(pathToFileURL(path.join(directory, 'utils/stream_activity.js')).href);
    return { mongoose, schemas, projectStreamActivityBatch };
}

if (process.argv[2] === '--reference-worker') {
    const [, , , directory, database, limit, mode] = process.argv;
    assertDatabase(database);
    const { mongoose, projectStreamActivityBatch } = await referenceModules(directory);
    try {
        await mongoose.connect(uri, { dbName: database, serverSelectionTimeoutMS: 5000 });
        const start = performance.now();
        const first = await projectStreamActivityBatch(Number(limit));
        const firstBatchMs = performance.now() - start;
        const steadyStart = performance.now();
        let total = first, batches = Number(first !== 0);
        if (mode !== 'once') {
            for (;;) {
                const count = await projectStreamActivityBatch(Number(limit));
                if (!count) break;
                total += count; batches++;
            }
        }
        console.log(JSON.stringify({ total, batches, firstBatchMs, remainingMs: performance.now() - steadyStart,
            projectMs: performance.now() - start }));
    } catch (error) {
        console.error(JSON.stringify({ message: error.message, code: error.code,
            writeErrors: error.writeErrors?.map(row => ({ code: row.code })) }));
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
} else {
    await main();
}

async function compileReference(directory) {
    const ts = require('typescript');
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
    await symlink(path.join(root, 'dimabot/node_modules'), path.join(directory, 'node_modules'), 'dir');
    for (const relative of ['utils/stream_activity', 'schemas/stream_activity.schema', 'schemas/stream_session.schema']) {
        const source = await readFile(path.join(root, 'dimabot/src', `${relative}.ts`), 'utf8');
        const result = ts.transpileModule(source, { fileName: `${relative}.ts`, reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
        assert.equal(result.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error).length, 0);
        const output = path.join(directory, `${relative}.js`);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, result.outputText);
    }
}

function normalize(value) {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value?._bsontype === 'ObjectId') return { $oid: value.toHexString() };
    if (['Long', 'Int32', 'Double', 'Decimal128'].includes(value?._bsontype)) {
        const number = Number(value.toString());
        assert(Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER, 'unsafe numeric BSON');
        return number;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    return value;
}

async function snapshot(db) {
    const result = {};
    for (const name of collectionNames) {
        result[name] = (await db.collection(name).find().sort({ _id: 1 }).toArray()).map(row => {
            // Only these fields are inherently dependent on the process or wall clock.
            if (name === 'stream_activity_aggregates') delete row.updatedAt;
            if (name === 'stream_activity_states' && row._id === 'projector-v1') {
                delete row.owner; delete row.leaseUntil; delete row.updatedAt;
            }
            return normalize(row);
        });
    }
    return result;
}

async function main() {
    const { MongoClient, ObjectId } = require('mongodb');
    const argv = process.argv.slice(2);
    const benchmark = argv.includes('--benchmark');
    const argument = (flag, fallback) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
    const rustDriver = path.resolve(argument('--rust-driver', path.join(root, 'dima-rust/target/release/examples/stream_activity_fixture')));
    const benchmarkCount = Number(argument('--benchmark-count', '6000'));
    const benchmarkRuns = Number(argument('--benchmark-runs', '3'));
    assert(Number.isInteger(benchmarkCount) && benchmarkCount >= 1000 && benchmarkCount <= 100000);
    assert(Number.isInteger(benchmarkRuns) && benchmarkRuns >= 1 && benchmarkRuns <= 5);
    const temporary = await mkdtemp(path.join(tmpdir(), 'stream-activity-parity-'));
    const ownedDatabases = new Set();
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    let workerIndex = 0;
    try {
        await compileReference(temporary);
        const { schemas, mongoose } = await referenceModules(temporary);
        const models = [schemas.StreamActivitySchema, schemas.StreamActivityAggregateSchema, schemas.StreamActivityStateSchema];
        const rows = streamActivityFixtures(ObjectId).map(row => new schemas.StreamActivitySchema(row).toObject());
        const eligible = rows.filter(row => !row.processed && row.expiresAt.getTime() > Date.now());
        assert.equal(eligible.length, 16);
        await client.connect();
        const buildInfo = await client.db('admin').command({ buildInfo: 1 });
        assert.match(buildInfo.version, /^8\.(?:[2-9]|[1-9][0-9])\./, 'MongoDB 8.2+ required for client bulk writes');
        console.log(`MongoDB ${buildInfo.version}; source TypeScript compiled to Node JavaScript; Rust release fixture driver`);

        const database = async (label, input = rows, seq = 0) => {
            const name = assertDatabase(`${prefix}${process.pid}_${Date.now()}_${label.replaceAll('typescript', 'ts').replaceAll('rust', 'rs')}`);
            assert(Buffer.byteLength(name) <= 63, 'fixture database name must fit MongoDB limit');
            ownedDatabases.add(name);
            const db = client.db(name);
            for (const model of models) {
                const collection = db.collection(model.collection.name);
                await db.createCollection(model.collection.name);
                for (const [keys, options] of model.schema.indexes()) await collection.createIndex(keys, options);
            }
            if (input.length) await db.collection(collectionNames[0]).insertMany(input);
            await db.collection(collectionNames[2]).insertMany([
                { _id: 'projector-v1', seq, leaseUntil: new Date(0) }, dashboardState
            ]);
            return db;
        };

        const run = async (language, db, { batch = 3, once = false, failure = false, measure = false } = {}) => {
            assert(ownedDatabases.has(db.databaseName), 'worker database must be owned by this invocation');
            const command = language === 'typescript' ? process.execPath : rustDriver;
            const args = language === 'typescript'
                ? [script, '--reference-worker', temporary, db.databaseName, String(batch), once ? 'once' : 'drain']
                : [db.databaseName, String(batch), once ? 'once' : 'drain'];
            const metricsPath = path.join(temporary, `metrics-${workerIndex++}.txt`);
            const started = performance.now();
            const child = spawn(measure ? '/usr/bin/time' : command,
                measure ? ['-v', '-o', metricsPath, command, ...args] : args,
                { env: { ...process.env, STREAM_ACTIVITY_TEST_URI: uri }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            const exitCode = await new Promise((resolve, reject) => {
                let timedOut = false;
                const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGKILL'); }, 120000);
                child.on('error', error => { clearTimeout(timer); reject(error); });
                child.on('close', code => {
                    clearTimeout(timer);
                    if (timedOut) reject(new Error(`${language} fixture worker timed out`));
                    else resolve(code);
                });
            });
            const elapsedMs = performance.now() - started;
            if (failure) {
                assert.notEqual(exitCode, 0, `${language} must surface a nonduplicate write failure`);
                assert.match(stderr, /121|validation/i, `${language} must report the validator failure`);
                return;
            }
            assert.equal(exitCode, 0, `${language} worker failed: ${stderr}`);
            const result = JSON.parse(stdout.trim().split('\n').at(-1));
            if (measure) {
                const metrics = await readFile(metricsPath, 'utf8');
                const metric = name => Number(metrics.match(new RegExp(`${name}:\\s*([0-9.]+)`))?.[1]);
                Object.assign(result, { elapsedMs, peakRssKiB: metric('Maximum resident set size \\(kbytes\\)'),
                    userCpuSeconds: metric('User time \\(seconds\\)'), systemCpuSeconds: metric('System time \\(seconds\\)') });
                for (const name of ['peakRssKiB', 'userCpuSeconds', 'systemCpuSeconds']) assert(Number.isFinite(result[name]), `missing GNU time metric ${name}`);
            }
            return result;
        };

        const assertDashboard = async db => assert.deepEqual(normalize(await db.collection(collectionNames[2]).findOne({ _id: dashboardState._id })), normalize(dashboardState));
        const compare = async (actual, expected, label) => {
            assert.deepEqual(await snapshot(actual), await snapshot(expected), label);
            await assertDashboard(actual);
        };
        const baselineTS = await database('baseline_ts');
        const baselineRust = await database('baseline_rust');
        for (const db of [baselineTS, baselineRust]) await db.collection(collectionNames[2]).deleteOne({ _id: 'projector-v1' });
        assert.equal((await run('typescript', baselineTS)).total, eligible.length);
        assert.equal((await run('rust', baselineRust)).total, eligible.length);
        await compare(baselineRust, baselineTS, 'mixed events, defaults, Unicode hashes, labels, ObjectIds, repeated chatter across batches');
        const aggregates = await baselineTS.collection(collectionNames[1]).find().toArray();
        assert.equal(aggregates.filter(row => row.scope === 'distinct' && row.actor === '698614112').length, 0);
        assert.equal(aggregates.filter(row => row.scope === 'summary').reduce((sum, row) => sum + row.messages, 0), 7);
        const stable = await snapshot(baselineRust);
        assert.equal((await run('rust', baselineRust)).total, 0);
        assert.deepEqual(await snapshot(baselineRust), stable, 'empty replay must leave persisted content unchanged');
        console.log('PASS mixed-event exact parity, defaults, Unicode identities, bot distinct exclusion, cross-batch deduplication and empty replay');

        const emptyTS = await database('empty_ts', []);
        const emptyRust = await database('empty_rust', []);
        for (const [language, db] of [['typescript', emptyTS], ['rust', emptyRust]]) {
            await db.collection(collectionNames[2]).deleteOne({ _id: 'projector-v1' });
            assert.equal((await run(language, db)).total, 0);
        }
        await compare(emptyRust, emptyTS, 'initial checkpoint upsert defaults on an empty activity collection');
        console.log('PASS initial checkpoint creation, including empty-collection defaults');

        for (const language of ['typescript', 'rust']) {
            const busy = await database(`busy_${language}`);
            await busy.collection(collectionNames[2]).updateOne({ _id: 'projector-v1' }, { $set: { owner: 'fixture-busy', leaseUntil: new Date('2100-01-01'), seq: 9 } });
            const before = await snapshot(busy);
            assert.equal((await run(language, busy, { once: true })).total, 0);
            assert.deepEqual(await snapshot(busy), before);
            await assertDashboard(busy);
        }
        console.log('PASS held lease prevents both processors from changing activities or aggregates');

        const recoveryBaseline = await database('recovery_baseline', rows, 6);
        await run('typescript', recoveryBaseline, { batch: 1000 });
        const completedAggregates = await recoveryBaseline.collection(collectionNames[1]).find().sort({ _id: 1 }).toArray();
        for (const mode of ['partial', 'processed', 'validation']) for (const language of ['typescript', 'rust']) {
            const db = await database(`${mode}_${language}`, rows, 6);
            if (mode !== 'validation') {
                const copies = completedAggregates.filter((row, index) => mode === 'processed' || row.scope === 'distinct' || index % 2 === 0);
                await db.collection(collectionNames[1]).insertMany(copies);
                await db.collection(collectionNames[2]).updateOne({ _id: 'projector-v1' }, { $set: { seq: 7, active: { seq: 7, ids: eligible.map(row => row._id) } } });
                if (mode === 'processed') await db.collection(collectionNames[0]).updateMany({ _id: { $in: eligible.map(row => row._id) } }, { $set: { processed: true } });
            } else {
                await db.command({ collMod: collectionNames[1], validator: { scope: { $ne: 'summary' } }, validationLevel: 'strict', validationAction: 'error' });
                await run(language, db, { batch: 1000, once: true, failure: true });
                assert.equal(await db.collection(collectionNames[0]).countDocuments({ _id: { $in: eligible.map(row => row._id) }, processed: true }), 0);
                const failedState = await db.collection(collectionNames[2]).findOne({ _id: 'projector-v1' });
                assert.equal(failedState.seq, 7);
                assert.deepEqual(failedState.active.ids, eligible.map(row => row._id));
                assert(await db.collection(collectionNames[1]).countDocuments() > 0, 'must exercise partial unordered writes');
                await db.command({ collMod: collectionNames[1], validator: {}, validationLevel: 'strict' });
            }
            assert.equal((await run(language, db, { batch: 1000 })).total, eligible.length);
            await compare(db, recoveryBaseline, `${language} ${mode} recovery must match uninterrupted seq-7 projection exactly`);
        }
        console.log('PASS both implementations recover partial writes, processed-before-state-clear and nonduplicate validator error 121');

        for (const language of ['typescript', 'rust']) {
            const db = await database(`concurrent_${language}`);
            const concurrent = await Promise.allSettled([run(language, db), run(language, db)]);
            for (const result of concurrent) assert.equal(result.status, 'fulfilled', result.reason?.message);
            await run(language, db);
            await compare(db, baselineTS, `${language} concurrent processors preserve totals and batch fences`);
        }
        console.log('PASS concurrent processors respect lease and avoid duplicate projection');

        if (benchmark) {
            const data = benchmarkFixtures(ObjectId, benchmarkCount).map(row => new schemas.StreamActivitySchema(row).toObject());
            const results = [];
            for (let iteration = 0; iteration < benchmarkRuns; iteration++) {
                const dbs = {};
                // Alternate order to reduce a fixed cold-cache/order advantage.
                for (const language of iteration % 2 ? ['rust', 'typescript'] : ['typescript', 'rust']) {
                    const db = await database(`benchmark_${iteration}_${language}`, data);
                    dbs[language] = db;
                    const metrics = await run(language, db, { batch: 500, measure: true });
                    assert.equal(metrics.total, benchmarkCount);
                    results.push({ language, iteration, events: benchmarkCount, ...metrics,
                        startupInclusiveEventsPerSecond: benchmarkCount * 1000 / metrics.elapsedMs,
                        afterFirstBatchEventsPerSecond: (benchmarkCount - 500) * 1000 / metrics.remainingMs });
                }
                await compare(dbs.rust, dbs.typescript, 'benchmark workload exact persisted parity');
            }
            console.log(JSON.stringify({ benchmark: results, methodology: 'Same generated input, source indexes, batch 500 and disposable Mongo fixture. Release Rust versus compiled JavaScript Node, one long-lived process per run. GNU time peak RSS and user+system CPU include startup/shutdown; harness elapsed includes spawn. afterFirstBatch excludes first 500 events, includes final empty poll. TS reference omits cron telemetry/bootstrap. Mongo CPU/RAM and whole-host effects are not attributed to worker process. First batch is a limited warmup, not a full JIT stabilization study.' }, null, 2));
        }
        await mongoose.disconnect();
    } finally {
        try {
            for (const name of ownedDatabases) await client.db(assertDatabase(name)).dropDatabase();
        } finally {
            await client.close();
            await rm(temporary, { recursive: true, force: true });
        }
    }
}
