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
const require = createRequire(new URL('../package.json', import.meta.url));
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
    const [, , , directory, database, limit, mode, warmup = '1000'] = process.argv;
    assertDatabase(database);
    const warmupTarget = Number(warmup);
    assert(Number.isSafeInteger(warmupTarget) && warmupTarget > 0, 'positive warmup event target required');
    const { mongoose, projectStreamActivityBatch } = await referenceModules(directory);
    try {
        await mongoose.connect(uri, { dbName: database, serverSelectionTimeoutMS: 5000 });
        const start = performance.now();
        let firstBatchMs = 0, steadyStart = start, warmupEnd = null, total = 0, warmupEvents = 0;
        const batchMs = [], afterWarmupBatchMs = [];
        for (;;) {
            const warming = total < warmupTarget;
            const batchLimit = warming ? Math.min(Math.max(1, Math.min(1000, Number(limit))), warmupTarget - total) : Number(limit);
            const batchStart = performance.now();
            const count = await projectStreamActivityBatch(batchLimit);
            const finished = performance.now();
            if (!batchMs.length) { firstBatchMs = finished - start; steadyStart = finished; }
            if (!count) break;
            batchMs.push(finished - batchStart);
            if (!warming) afterWarmupBatchMs.push(finished - batchStart);
            total += count;
            if (warming) {
                warmupEvents += count;
                if (total >= warmupTarget) warmupEnd = finished;
            }
            if (mode === 'once') break;
        }
        const finished = performance.now();
        console.log(JSON.stringify({ total, batches: batchMs.length, firstBatchMs, remainingMs: finished - steadyStart,
            projectMs: finished - start, warmupEvents, afterWarmupEvents: total - warmupEvents,
            afterWarmupMs: warmupEnd === null ? null : finished - warmupEnd, batchMs, afterWarmupBatchMs }));
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

function median(values) {
    values = values.filter(Number.isFinite);
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function latencyStats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, median: median(sorted), p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
}

async function pendingQueryPlan(db, batch) {
    const explained = await db.collection(collectionNames[0]).find({ processed: false, expiresAt: { $gt: new Date() } })
        .sort({ occurredAt: 1, _id: 1 }).project({ _id: 1 }).limit(batch).explain('executionStats');
    const indexes = new Set(), stages = new Set();
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.indexName === 'string') indexes.add(value.indexName);
        if (typeof value.stage === 'string') stages.add(value.stage);
        for (const child of Object.values(value)) walk(child);
    };
    walk(explained.queryPlanner.winningPlan);
    return { winningIndexes: [...indexes].sort(), stages: [...stages].sort(),
        blockingSort: [...stages].some(stage => stage.toUpperCase() === 'SORT'),
        nReturned: explained.executionStats.nReturned, keysExamined: explained.executionStats.totalKeysExamined,
        docsExamined: explained.executionStats.totalDocsExamined, executionTimeMs: explained.executionStats.executionTimeMillis };
}

async function main() {
    const { MongoClient, ObjectId } = require('mongodb');
    const argv = process.argv.slice(2);
    const benchmarkOnly = argv.includes('--benchmark-only');
    const benchmark = argv.includes('--benchmark') || benchmarkOnly;
    const argument = (flag, fallback) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback;
    const rustDriver = path.resolve(argument('--rust-driver', path.join(root, 'dimabot/target/release/examples/stream_activity_fixture')));
    const benchmarkCount = Number(argument('--benchmark-count', '6000'));
    const benchmarkRuns = Number(argument('--benchmark-runs', '3'));
    const benchmarkBatches = argument('--benchmark-batches', '500').split(',').map(Number);
    const benchmarkWorkloads = argument('--benchmark-workloads', 'repeated').split(',');
    assert(benchmarkBatches.length > 0 && benchmarkBatches.every(batch => Number.isInteger(batch) && batch >= 1 && batch <= 1000), 'benchmark batches must be comma-separated integers from 1 through 1000');
    assert.equal(new Set(benchmarkBatches).size, benchmarkBatches.length, 'duplicate benchmark batch sizes');
    assert(benchmarkWorkloads.length > 0 && benchmarkWorkloads.every(workload => ['repeated', 'diverse'].includes(workload)), 'benchmark workloads must be repeated and/or diverse');
    assert.equal(new Set(benchmarkWorkloads).size, benchmarkWorkloads.length, 'duplicate benchmark workloads');
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

        const run = async (language, db, { batch = 3, once = false, failure = false, measure = false, warmup = 1000 } = {}) => {
            assert(ownedDatabases.has(db.databaseName), 'worker database must be owned by this invocation');
            const command = language === 'typescript' ? process.execPath : rustDriver;
            const args = language === 'typescript'
                ? [script, '--reference-worker', temporary, db.databaseName, String(batch), once ? 'once' : 'drain', String(warmup)]
                : [db.databaseName, String(batch), once ? 'once' : 'drain', String(warmup)];
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
                const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120000);
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
        if (!benchmarkOnly) {
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
        }

        if (benchmark) {
            const results = [], queryPlans = [], workloads = {};
            for (const workload of benchmarkWorkloads) {
                const data = benchmarkFixtures(ObjectId, benchmarkCount, workload).map(row => new schemas.StreamActivitySchema(row).toObject());
                workloads[workload] = { data, shape: {
                    channels: new Set(data.map(row => row.channelID)).size,
                    actors: new Set(data.map(row => row.actor)).size,
                    buckets: new Set(data.map(row => Math.floor(row.offset / 300))).size,
                    emotes: new Set(data.flatMap(row => row.emotes.map(emote => emote.key))).size
                } };
            }
            const pairs = benchmarkWorkloads.flatMap(workload => benchmarkBatches.map(batchSize => ({ workload, batchSize })));
            for (let iteration = 0; iteration < benchmarkRuns; iteration++) {
                for (let offset = 0; offset < pairs.length; offset++) {
                    const pairIndex = (offset + iteration) % pairs.length;
                    const { workload, batchSize } = pairs[pairIndex];
                    const dbs = {};
                    // Rotate pair order and alternate language order across pairs/runs.
                    for (const language of (iteration + pairIndex) % 2 ? ['rust', 'typescript'] : ['typescript', 'rust']) {
                        const db = await database(`b${iteration}_${pairIndex}_${language}`, workloads[workload].data);
                        dbs[language] = db;
                        const plan = await pendingQueryPlan(db, batchSize);
                        assert.equal(plan.nReturned, Math.min(batchSize, benchmarkCount));
                        queryPlans.push({ language, iteration, workload, batchSize, ...plan });
                        const metrics = await run(language, db, { batch: batchSize, measure: true, warmup: 1000 });
                        assert.equal(metrics.total, benchmarkCount);
                        assert.equal(metrics.warmupEvents, 1000, 'all matrix cases must warm up on exactly 1000 events');
                        assert(Number.isFinite(metrics.afterWarmupMs) && metrics.afterWarmupMs > 0);
                        results.push({ language, iteration, workload, batchSize, events: benchmarkCount, ...metrics,
                            peakRssMiB: metrics.peakRssKiB / 1024,
                            wholeProcessCpuSeconds: metrics.userCpuSeconds + metrics.systemCpuSeconds,
                            batchLatencyMs: latencyStats(metrics.batchMs),
                            afterWarmupBatchLatencyMs: latencyStats(metrics.afterWarmupBatchMs),
                            startupInclusiveEventsPerSecond: benchmarkCount * 1000 / metrics.elapsedMs,
                            afterFirstBatchEventsPerSecond: (benchmarkCount - Math.min(batchSize, 1000)) * 1000 / metrics.remainingMs,
                            afterWarmupEventsPerSecond: metrics.afterWarmupEvents ? metrics.afterWarmupEvents * 1000 / metrics.afterWarmupMs : null });
                    }
                    await compare(dbs.rust, dbs.typescript, `benchmark ${workload} batch ${batchSize} exact persisted parity`);
                    for (const db of Object.values(dbs)) {
                        await db.dropDatabase();
                        ownedDatabases.delete(db.databaseName);
                    }
                    console.log(`BENCH completed ${workload}, batch ${batchSize}, run ${iteration + 1}/${benchmarkRuns}; exact persisted parity`);
                }
            }
            const summaryMedians = pairs.flatMap(({ workload, batchSize }) => ['typescript', 'rust'].map(language => {
                const runs = results.filter(row => row.workload === workload && row.batchSize === batchSize && row.language === language);
                const fields = ['peakRssMiB', 'wholeProcessCpuSeconds', 'afterWarmupEventsPerSecond', 'startupInclusiveElapsedMs', 'startupInclusiveEventsPerSecond'];
                return { workload, batchSize, language, runs: runs.length,
                    ...Object.fromEntries(fields.map(field => [field, median(runs.map(row => field === 'startupInclusiveElapsedMs' ? row.elapsedMs : row[field]))])),
                    medianOfRunBatchMedianMs: median(runs.map(row => row.batchLatencyMs.median)),
                    medianOfRunBatchP95Ms: median(runs.map(row => row.batchLatencyMs.p95)) };
            }));
            console.log(JSON.stringify({ configuration: { node: process.version, mongodb: buildInfo.version,
                eventsPerRun: benchmarkCount, runsPerLanguage: benchmarkRuns, batches: benchmarkBatches,
                workloads: Object.fromEntries(Object.entries(workloads).map(([name, value]) => [name, value.shape])),
                warmupEvents: 1000, indexes: 'unchanged source Mongoose schema indexes', paritySuiteRun: !benchmarkOnly },
                summaryMedians, benchmark: results, queryPlans,
                methodology: 'Same deterministic input per workload, source indexes and disposable Mongo fixture. Release Rust versus compiled JavaScript Node; source compilation happens outside measured children, one long-lived process per run. Pair/language order rotates. GNU time peak RSS and user+system CPU include startup/shutdown; harness elapsed includes spawn. afterWarmup excludes exactly 1000 events for every batch size and includes the final empty poll; a partial warmup batch is used if needed. Throughput is null if no events remain after warmup. This is limited warmup, not full JIT stabilization. Legacy firstBatch/remaining metrics are retained. Batch latency summaries cover successful nonempty batches, excluding the final empty poll; afterWarmupBatch summaries exclude warmup batches. Pending-query executionStats are collected before each measured run and warm its collection/index pages. TS reference omits cron telemetry/bootstrap. Mongo CPU/RAM and whole-host effects are excluded from worker metrics. Synthetic fixtures on a shared host do not establish production or API performance guarantees.' }, null, 2));
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
