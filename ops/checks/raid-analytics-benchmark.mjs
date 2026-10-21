// Run only through saas-ops verify cron-RUN with private mongo/redis dependencies.
// Fixtures: cron-boot.mjs, bench-typescript.mjs, bench-resource.py,
// baseline_raid_analytics (exact pre-change production release binary).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire('/app/package.json');
const { MongoClient, ObjectId } = require('mongodb');
const mongoose = require('mongoose');
const uri = new URL(process.env.MONGO_URI);
assert.equal(uri.hostname, 'mongo'); assert.equal(process.env.DRAGONFLY_HOST, 'redis');
assert.match(uri.pathname, /^\/raid_analytics_fixture_[a-zA-Z0-9_]+$/);
const deadline = Date.now() + 245000, owned = new Set(), children = new Set();
const timer = setTimeout(() => { console.error('Benchmark exceeded internal 245-second deadline'); process.exitCode = 1;
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
}, 245000);
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000, timeoutMS: 5000 });
mongoose.set('autoIndex', false);
const { RaidAnalyticsHistorySchema: History, RaidAnalyticsSummarySchema: Summary } = await import('/app/dist/schemas/raid_analytics.schema.js');
const { DomainEventSchema: Events } = await import('/app/dist/schemas/domain_event.schema.js');
const { projectRaidSummaryOnce } = await import('/app/dist/utils/raid_analytics.js');
const names = { history: History.collection.name, summary: Summary.collection.name, events: Events.collection.name };
const DAY = 86400000, now = Date.now(), expiry = new Date(now + 90 * DAY), warmup = 2, channels = 10;
const runtimes = ['typescript', 'baseline_rust', 'candidate_rust'];
const workloads = { quiet: { historiesPerChannel: 0, followsPerChannel: 0 },
    moderate: { historiesPerChannel: 48, followsPerChannel: 96 },
    dense: { historiesPerChannel: 320, followsPerChannel: 640 } };
const paths = { baseline_rust: '/tmp/saas-fixtures/baseline_raid_analytics', candidate_rust: '/usr/local/bin/raid_analytics' };
function normalize(value) {
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value?._bsontype === 'ObjectId') return { $oid: value.toHexString() };
    if (['Long', 'Int32', 'Double', 'Decimal128'].includes(value?._bsontype)) return Number(value.toString());
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
    return value;
}
function payload(value) {
    const result = normalize(value);
    for (const period of ['7', '30']) result[period].totals.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    return result;
}
async function bounded(promise, milliseconds, label) {
    let timeout;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), Math.min(milliseconds, Math.max(1, deadline - Date.now())));
    })]); } finally { clearTimeout(timeout); }
}
function data(shape) {
    const histories = [], events = [];
    for (let c = 0; c < channels; c++) {
        const channelID = `bench-channel-${String(c).padStart(2, '0')}`;
        for (let i = 0; i < shape.historiesPerChannel; i++) {
            const direction = i % 3 === 0 ? 'outgoing' : 'incoming';
            const occurredAt = new Date(now - 2 * 3600000 - Math.floor(i / 20) * DAY - (i % 20) * 90000);
            histories.push(new History({ _id: `raid-${c}-${String(i).padStart(4, '0')}`, channelID, direction,
                peerID: `peer-${i % 13}`, peerLogin: `peer_${i % 13}`, peerName: `Peer ${i % 13}`, viewers: i % 113,
                occurredAt, expiresAt: expiry }).toObject());
        }
        if (shape.historiesPerChannel) for (const [tag, direction, at, expiresAt] of [
            ['old-reciprocity', 'outgoing', now - 40 * DAY, expiry],
            ['future', 'outgoing', now + DAY, expiry], ['expired', 'incoming', now - 1000, new Date(now - DAY)],
            ['open', 'incoming', now - 30000, expiry]]) {
            histories.push(new History({ _id: `${tag}-${c}`, channelID, direction, peerID: 'peer-1',
                peerName: 'Peer 1', peerLogin: 'peer_1', viewers: 5, occurredAt: new Date(at), expiresAt }).toObject());
        }
        for (let i = 0; i < shape.followsPerChannel; i++) {
            const key = `follow-${c}-${i}`;
            events.push(new Events({ _id: new ObjectId(), eventKey: key, sourceEventId: key,
                channelID, source: 'twitch-eventsub', type: 'channel.follow.received', topic: 'channel', payload: {},
                occurredAt: new Date(now - 2 * 3600000 - Math.floor(i / 40) * DAY - (i % 40) * 45000 + 15000),
                journaledAt: new Date(now), expiresAt: expiry }).toObject());
        }
    }
    return { histories, events };
}
const initialized = new Set();
async function database(role, input) {
    assert(['actual', 'reference'].includes(role));
    const name = `raid_analytics_fixture_b${process.pid}_${role}`;
    assert.match(name, /^raid_analytics_fixture_[a-zA-Z0-9_]+$/); owned.add(name);
    assert(owned.size <= 2, 'benchmark must reuse exactly two fixture databases');
    const db = client.db(name);
    if (!initialized.has(name)) {
        for (const model of [History, Summary, Events]) {
            await db.createCollection(model.collection.name);
            for (const [keys, options] of model.schema.indexes()) await db.collection(model.collection.name).createIndex(keys, options);
        }
        initialized.add(name);
    }
    // Clear/reseed outside timing. Keep collection/index identities throughout
    // all 27 runs: rapid drop/create churn can exhaust fixture WiredTiger FDs
    // before its asynchronous catalogue cleanup catches up.
    for (const collection of Object.values(names)) await db.collection(collection).deleteMany({});
    if (input.histories.length) await db.collection(names.history).insertMany(input.histories);
    if (input.events.length) await db.collection(names.events).insertMany(input.events);
    await db.collection(names.summary).insertMany(Array.from({ length: channels }, (_, i) => ({
        _id: `bench-channel-${String(i).padStart(2, '0')}`, dirtyAt: new Date(0),
        nextRefreshAt: new Date(i), leaseUntil: new Date(0) })));
    return db;
}
async function run(runtime, db) {
    const runUri = new URL(uri.href); runUri.pathname = `/${db.databaseName}`;
    const native = runtime !== 'typescript';
    const command = native ? paths[runtime] : process.execPath;
    const args = native ? ['--telemetry-json', '--database', db.databaseName]
        : ['/tmp/saas-fixtures/bench-typescript.mjs', String(channels)];
    const started = performance.now();
    const child = spawn('python3', ['/tmp/saas-fixtures/bench-resource.py', command, ...args], {
        detached: true, cwd: '/app', env: { PATH: process.env.PATH, MONGO_URI: runUri.href, TZ: 'UTC', NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let pending = '', stderr = '', pid, usage, warmAt, workerPeakRssBytes, finalSnapshot;
    const batches = [];
    let protocolError;
    child.stdout.on('data', chunk => {
        pending += chunk;
        if (pending.length > 65536) { protocolError = new Error('Oversized benchmark output'); child.kill('SIGTERM'); return; }
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) try {
            if (line.startsWith('raid_bench_process:')) pid = JSON.parse(line.slice('raid_bench_process:'.length)).pid;
            if (line.startsWith('raid_bench_resource:')) usage = JSON.parse(line.slice('raid_bench_resource:'.length));
            if (!line.startsWith('raid_analytics:')) continue;
            const frame = JSON.parse(line.slice('raid_analytics:'.length));
            if (frame.event !== 'batch') continue;
            assert.equal(frame.success, true);
            if (frame.events === 1) {
                assert(Number.isFinite(frame.durationMs) && frame.durationMs >= 0);
                batches.push(frame.durationMs);
                if (batches.length === warmup) warmAt = performance.now();
                if (batches.length === channels) {
                    assert(pid); process.kill(pid, 'SIGSTOP');
                    finalSnapshot = (async () => {
                        try {
                            const status = await readFile(`/proc/${pid}/status`, 'utf8');
                            assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m);
                            workerPeakRssBytes = Number(status.match(/^VmHWM:\s+(\d+)\s+kB$/m)?.[1]) * 1024;
                            assert(Number.isFinite(workerPeakRssBytes) && workerPeakRssBytes > 0);
                        } catch (error) { protocolError = error; }
                        finally { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGTERM'); }
                    })();
                    finalSnapshot.catch(error => { protocolError = error; child.kill('SIGTERM'); });
                }
            }
        } catch (error) { protocolError = error; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const completion = new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.benchCompletion = completion;
    try {
        const exit = await bounded(completion, 18000, `${runtime} benchmark drain`);
        await finalSnapshot;
        if (protocolError) throw protocolError;
        assert(Number.isFinite(workerPeakRssBytes) && workerPeakRssBytes > 0);
        assert.equal(exit.code, 0, stderr); assert.equal(exit.signal, null);
        assert.equal(batches.length, channels); assert.equal(usage?.exitCode, 0);
        const elapsedMs = performance.now() - started;
        for (const key of ['userCpuSeconds', 'systemCpuSeconds', 'forkExecPeakRssBytes']) assert(Number.isFinite(usage[key]) && usage[key] >= 0);
        const measuredMs = batches.slice(warmup).reduce((a, b) => a + b, 0);
        return { runtime, channels, warmupChannels: warmup, measuredChannels: channels - warmup,
            ...usage, peakRssBytes: workerPeakRssBytes, elapsedMs, wholeProcessCpuSecondsPerRefreshedChannel: (usage.userCpuSeconds + usage.systemCpuSeconds) / channels,
            startupInclusiveChannelsPerSecond: channels * 1000 / elapsedMs,
            afterWarmupThroughExitChannelsPerSecond: (channels - warmup) * 1000 / (performance.now() - warmAt),
            measuredProjectionMs: measuredMs, measuredProjectionChannelsPerSecond: (channels - warmup) * 1000 / measuredMs,
            batchMs: batches };
    } finally {
        if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await completion.catch(() => {}); }
        children.delete(child);
    }
}
async function parity(actual, expected) {
    await mongoose.disconnect();
    await mongoose.connect(uri.href, { dbName: expected.databaseName, serverSelectionTimeoutMS: 5000 });
    const summaries = await actual.collection(names.summary).find().sort({ _id: 1 }).toArray();
    assert.equal(summaries.length, channels);
    for (const row of summaries) {
        assert(row.updatedAt instanceof Date); const at = +row.updatedAt;
        assert.equal(row.error, false); assert.equal(+row.leaseUntil, 0); assert.equal(+row.nextRefreshAt, at + 60000);
        await expected.collection(names.summary).updateMany({}, { $set: { nextRefreshAt: new Date(at + DAY) } });
        await expected.collection(names.summary).updateOne({ _id: row._id }, { $set: { nextRefreshAt: new Date(0) } });
        const RealDate = globalThis.Date;
        function FrozenDate(...args) { return new.target ? Reflect.construct(RealDate, args.length ? args : [at]) : new RealDate(at).toString(); }
        FrozenDate.prototype = RealDate.prototype; Object.setPrototypeOf(FrozenDate, RealDate); FrozenDate.now = () => at;
        globalThis.Date = FrozenDate;
        try { assert.equal(await projectRaidSummaryOnce(), true); } finally { globalThis.Date = RealDate; }
        const reference = await expected.collection(names.summary).findOne({ _id: row._id });
        assert.deepEqual(payload(row.payload), payload(reference.payload), 'exact persisted payload against unchanged TS at native business clock');
        const query = { channelID: row._id, expiresAt: { $gt: new Date(at) } };
        const rows = db => db.collection(names.history).find(query).sort({ _id: 1 }).toArray();
        assert.deepEqual(normalize(await rows(actual)), normalize(await rows(expected)), 'exact BSON dates, follow counts and windows');
    }
    await mongoose.disconnect();
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let paused;
try {
    await chmod('/tmp/saas-fixtures', 0o755);
    await chmod(paths.baseline_rust, 0o755);
    await chmod('/tmp/saas-fixtures/bench-typescript.mjs', 0o644);
    const identities = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, value]) => [key,
        { sha256: createHash('sha256').update(await readFile(value)).digest('hex') }])));
    assert.equal(identities.baseline_rust.sha256, '08b562c3350fd104f8b49a80b27d59f9f50ea2cb4ac1178d2fcd6c6fcab7b8e9');
    // Freeze the actual supervised raid child to keep it out of measured work.
    await bounded((async () => { while (!paused) {
        let rows = []; try { rows = (await readFile('/tmp/saas-fixtures/raid-spawns.jsonl', 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
        const dead = new Set(rows.filter(row => row.event === 'exit').map(row => row.pid));
        paused = rows.findLast(row => row.event === 'spawn' && row.native && !dead.has(row.pid))?.pid;
        if (!paused) await delay(40);
    } })(), 10000, 'fixture supervisor native startup');
    process.kill(paused, 'SIGSTOP');
    await client.connect(); const info = await client.db('admin').command({ buildInfo: 1 });
    const results = [], order = [];
    for (let iteration = 0; iteration < 3; iteration++) for (let w = 0; w < 3; w++) {
        const workload = Object.keys(workloads)[(w + iteration) % 3], input = data(workloads[workload]);
        const runtimeOrder = iteration % 2 ? [...runtimes].reverse() : [...runtimes];
        // Rotate the middle runtime as well, so each occupies first/middle/last.
        const rotated = runtimeOrder.slice(w).concat(runtimeOrder.slice(0, w));
        for (const runtime of rotated) {
            assert(Date.now() < deadline - 15000, 'leave cleanup time within helper deadline');
            const actual = await database('actual', input), reference = await database('reference', input);
            order.push({ iteration, workload, runtime });
            const result = await run(runtime, actual);
            await parity(actual, reference);
            results.push({ iteration, workload, persistedParity: true, ...result });
        }
        console.log(`BENCH PASS ${workload} repetition ${iteration + 1}/3; all three runtimes exact persisted parity`);
    }
    const fields = ['wholeProcessCpuSecondsPerRefreshedChannel', 'peakRssBytes', 'elapsedMs', 'startupInclusiveChannelsPerSecond',
        'afterWarmupThroughExitChannelsPerSecond', 'measuredProjectionMs', 'measuredProjectionChannelsPerSecond'];
    const summaryMedians = Object.keys(workloads).flatMap(workload => runtimes.map(runtime => {
        const group = results.filter(row => row.workload === workload && row.runtime === runtime); assert.equal(group.length, 3);
        return { workload, runtime, repetitions: group.length, ...Object.fromEntries(fields.map(key => [key, median(group.map(row => row[key]))])) };
    }));
    console.log('RAID_BENCHMARK_JSON ' + JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
        runtimeIdentity: { node: process.version, mongodb: info.version, platform: process.platform, arch: process.arch, ...identities,
            compiledTypeScriptProjectorSha256: createHash('sha256').update(await readFile('/app/dist/utils/raid_analytics.js')).digest('hex') },
        configuration: { repetitions: 3, channelsPerRun: channels, warmupChannels: warmup,
            workloads: Object.fromEntries(Object.entries(workloads).map(([name, shape]) => [name, { ...shape,
                extraBoundaryHistoriesPerChannel: shape.historiesPerChannel ? 4 : 0,
                totalHistoriesPerRun: channels * (shape.historiesPerChannel + (shape.historiesPerChannel ? 4 : 0)),
                totalFollowsPerRun: channels * shape.followsPerChannel }])),
            indexes: 'identical unchanged Mongoose History/Summary/DomainEvent schema indexes, created once per fixture database',
            databaseStrategy: 'exactly two owned databases (actual/reference); retain collections/indexes, deleteMany and reseed outside timing before every run; drop only in finally',
            resourceEnvelope: { uid: 65534, gid: 65534, cgroup: await readFile('/proc/self/cgroup', 'utf8'),
                cpuMax: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => 'unavailable'),
                memoryMax: await readFile('/sys/fs/cgroup/memory.max', 'utf8').catch(() => 'unavailable') } },
        order, summaryMedians, results,
        methodology: [
            'Synthetic controlled projector-engine comparison only; excludes API, other SaaS services, MongoDB CPU/RSS and supervisor CPU/RSS. All measured children run sequentially within the same helper candidate cgroup, identical UID/GID and Mongo indexes/data; private disposable Mongo/Redis and inert unrelated workers.',
            'Python os.wait4 captures complete exited-child user+system CPU including final CPU tail, startup and shutdown. CPU/refreshed-channel divides exact whole-process CPU by all 10 channels; this is explicitly startup-inclusive, not exact steady-state CPU. No polling-tail extrapolation or startup CPU subtraction is used. Linux ru_maxrss is retained separately as forkExecPeakRssBytes because it can include Python memory inherited before exec.',
            'peakRssBytes is the actual executed worker Linux VmHWM, read from /proc/PID/status after the tenth completed batch while SIGSTOP prevents exit. Linux resets the executable address-space high-water mark on exec, avoiding the Python pre-exec RSS floor. The measurement includes actual-image startup and projection through completion, excludes shutdown; a shutdown-only peak is not claimed. TS waits for the same termination handshake; native uses its existing signal handler.',
            'Projection durations come from each real native batch frame and a TS driver timer around the unchanged source projector. First 2 channels are excluded from projection-engine throughput as limited warmup; 8-channel projection throughput uses sum of measured batch durations, excluding notification gaps, health checks between batches, startup and shutdown. Limited warmup does not establish full JIT stabilization. afterWarmupThroughExit includes notification and shutdown overhead.',
            'TS engine driver omits production worker mandatory 1-second sleep, cron bootstrap and telemetry. Real native CLI drains without artificial sleep; baseline and final candidate both retain the original four summary queries (two period facets and two period-specific reciprocity queries). The final candidate adds phase/health instrumentation, so baseline/candidate comparison includes that instrumentation cost. No query optimization or isolated query-CPU improvement is claimed.',
            'All runtimes sequentially reuse the same actual/reference database pair with identical fixture data, cleared via deleteMany and reseeded outside timing before each run. Immediately after timing, every channel payload and retained history is compared with unchanged TS at its own persisted updatedAt business clock; only unordered direction totals are sorted. Date/ObjectId semantics and all ordered recent/top arrays remain strict. Fixture parity/recovery check remains separate.',
            'Runtime and workload order rotate across three repetitions. Exactly two task-owned fixture databases retain the same source collections/indexes across all runs; indexes are created once, collection deletion/reseeding occurs outside timing, and databases are dropped only during final cleanup. This bounds WiredTiger catalogue/file-descriptor churn without changing MongoDB or host limits. Reseeding warms caches for each run; retained index pages and shared MongoDB caches are not a cold-cache comparison. Shared production host, small quiet fixtures and ten-channel runs limit generalization. No API or whole-SaaS performance claim.'
        ] }));
} finally {
    clearTimeout(timer);
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await Promise.allSettled([...children].map(child => child.benchCompletion));
    if (paused) { try { process.kill(paused, 'SIGCONT'); } catch {} }
    await mongoose.disconnect().catch(() => {});
    for (const name of owned) { assert.match(name, /^raid_analytics_fixture_[a-zA-Z0-9_]+$/); await client.db(name).dropDatabase().catch(() => {}); }
    await client.close();
}
