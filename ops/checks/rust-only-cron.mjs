// saas-ops candidate check: retired TypeScript worker entrypoints and the
// native-only cron supervisor.
//
// Run against the exact cron candidate with disposable Mongo/Redis and the
// rust-only fixture hook:
//
//   set -eu
//   RUST_ONLY_FIXTURES=$(mktemp -d /tmp/rust-only-cron-fixtures.XXXXXX)
//   trap 'rm -rf -- "$RUST_ONLY_FIXTURES"' EXIT
//   cp ops/checks/rust-only-cron-fixtures/cron-boot.mjs "$RUST_ONLY_FIXTURES/"
//   scripts/saas-ops verify cron-<run-id> \
//     --dependency mongo --dependency redis \
//     --test-env ops/checks/rust-only-cron-fixtures/test-env.json \
//     --fixtures "$RUST_ONLY_FIXTURES" \
//     --check ops/checks/rust-only-cron.mjs
//
// The real candidate supervisor runs with CRON_WORKER_RUNTIME=tsx and every
// retired runtime selector set to "typescript". It must still launch native
// Rust only. stream-activity is a real native child and projects a small fixture
// batch; ai-usage-receipts fails with ENOENT and roulette-completion exits
// nonzero so only same-Rust restarts can be observed. RAID_SESSIONS_RUNTIME is
// not one of the retired selectors: raid-sessions was added as native Rust and
// never had a TypeScript runtime switch, so it is only a stale-key no-op probe.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire('/app/package.json');
const { MongoClient, ObjectId } = require('mongodb');

const RETIRED = [
    { name: 'stream-activity', file: 'stream_activity.worker', command: '/usr/local/bin/stream_activity' },
    { name: 'raid-analytics', file: 'raid_analytics.worker', command: '/usr/local/bin/raid_analytics' },
    { name: 'follow-defense-baseline', file: 'follow_defense_baseline.worker', command: '/usr/local/bin/follow_defense_baseline' },
    { name: 'roulette-completion', file: 'roulette.worker', command: '/usr/local/bin/roulette_completion' },
    { name: 'ai-usage-receipts', file: 'ai_usage_receipts.worker', command: '/usr/local/bin/ai_usage_receipts' },
];
const SELECTORS = {
    'stream-activity': 'STREAM_ACTIVITY_RUNTIME',
    'raid-analytics': 'RAID_ANALYTICS_RUNTIME',
    'follow-defense-baseline': 'FOLLOW_DEFENSE_BASELINE_RUNTIME',
    'roulette-completion': 'ROULETTE_COMPLETION_RUNTIME',
    'ai-usage-receipts': 'AI_USAGE_RECEIPTS_RUNTIME',
};
// The sixth native child. It was migrated straight to Rust: RAID_SESSIONS_RUNTIME
// was never an implemented selector, so it is a hypothetical stale key, not a
// sixth retired switch. The archived source is still required to stay out of /app.
const NATIVE_ONLY = { name: 'raid-sessions', file: 'raid_sessions.worker', command: '/usr/local/bin/raid_sessions',
    staleKey: 'RAID_SESSIONS_RUNTIME' };
const NATIVE = [...RETIRED, NATIVE_ONLY];
const spawnLog = '/tmp/saas-fixtures/rust-only-spawns.jsonl';
const enoentWorker = process.env.RUST_ONLY_FIXTURE_ENOENT;
const nonzeroWorker = process.env.RUST_ONLY_FIXTURE_NONZERO;

const uri = new URL(process.env.MONGO_URI || '');
assert.equal(uri.hostname, 'mongo', 'only the disposable helper Mongo alias is permitted');
assert.equal(process.env.DRAGONFLY_HOST, 'redis', 'only the disposable helper Redis alias is permitted');
const databaseName = decodeURIComponent(uri.pathname.slice(1));
assert.match(databaseName, /^rust_only_fixture_[a-zA-Z0-9_]+$/);
assert.equal(process.env.CRON_WORKER_RUNTIME, 'tsx', 'exercise the development tsx runtime');
assert.equal(enoentWorker, 'ai-usage-receipts');
assert.equal(nonzeroWorker, 'roulette-completion');

async function absent(file, label) {
    try {
        await stat(file);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    assert.fail(`${label} must be absent: ${file}`);
}

async function walk(directory, depth = 0) {
    if (depth > 8) return [];
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const entry of entries) {
        if (['node_modules', '.git', 'coverage', 'data'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walk(full, depth + 1));
        else files.push(full);
    }
    return files;
}

async function records() {
    let text;
    try { text = await readFile(spawnLog, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.trim() ? text.trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

async function waitFor(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await check();
        if (value) return value;
        await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}

async function attempts() {
    const counts = {};
    for (const row of await records()) {
        if (row.event !== 'spawn' && row.event !== 'spawn-failed') continue;
        counts[row.worker] = (counts[row.worker] || 0) + 1;
    }
    return counts;
}

// 1. No archived source, compiled entrypoint, or source map exists in /app.
for (const worker of NATIVE) {
    await absent(`/app/src/workers/${worker.file}.ts`, 'retired TypeScript source');
    await absent(`/app/dist/workers/${worker.file}.js`, 'retired compiled entrypoint');
    await absent(`/app/dist/workers/${worker.file}.js.map`, 'retired source map');
}
await absent('/app/archives', 'the TypeScript worker archive');
const archived = new Set(NATIVE.map(worker => `${worker.file}.ts`));
for (const file of await walk('/app')) {
    assert(!archived.has(path.basename(file)), `archived worker source must not be in the app tree: ${file}`);
}
console.log('PASS six TypeScript src/dist/source-map entrypoints and the archive are absent from /app');

// 2. Registry definitions are native-only. No retired name carries a
// TypeScript source or dist entry, and the native metadata has no selector.
const { WORKERS, resolveWorkerLaunch } = await import('/app/dist/workers/cron.index.js');
const { NATIVE_WORKERS } = await import('/app/dist/utils/observability/native_worker_metrics.js');
assert.equal(WORKERS.filter(worker => worker.kind === 'native').length, NATIVE.length);
for (const item of NATIVE) {
    const definitions = WORKERS.filter(worker => worker.name === item.name);
    assert.equal(definitions.length, 1, `${item.name} must be registered exactly once`);
    const [definition] = definitions;
    assert.equal(definition.kind, 'native', `${item.name} must be a native registry entry`);
    assert.equal(definition.sourceEntry, undefined, `${item.name} must not retain a TypeScript source entry`);
    assert.equal(definition.distEntry, undefined, `${item.name} must not retain a compiled entry`);
    const metadata = NATIVE_WORKERS[item.name];
    assert(metadata, `${item.name} must have native metadata`);
    assert.equal(metadata.command, item.command);
    assert.equal(metadata.runtimeConfig, undefined, `${item.name} must not expose a TypeScript runtime config`);
    assert.equal(metadata.runtimeEnv, undefined, `${item.name} must not expose a TypeScript runtime selector`);
}
for (const worker of WORKERS.filter(entry => entry.kind === 'typescript')) {
    assert(worker.sourceEntry && worker.distEntry, `${worker.name} remains an active TypeScript worker`);
    for (const item of NATIVE) {
        assert(!worker.sourceEntry.includes(item.file) && !worker.distEntry.includes(item.file),
            `${worker.name} must not reference retired ${item.file}`);
    }
}
console.log('PASS six registry definitions are native-only; remaining TypeScript workers keep their entries');

// 3. node, tsx, and every retired selector value still resolve native Rust.
const registryEnv = { MONGO_URI: 'mongodb://mongo:27017/rust_only_fixture_registry', DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379', PATH: process.env.PATH };
try {
    for (const runtime of ['node', 'tsx']) {
        for (const selector of [undefined, 'rust', 'typescript']) {
            for (const item of RETIRED) {
                const key = SELECTORS[item.name];
                if (selector === undefined) delete process.env[key];
                else process.env[key] = selector;
                const definition = WORKERS.find(worker => worker.name === item.name);
                const launch = resolveWorkerLaunch(definition,
                    { runtime, once: true, dryRun: true, restartDelayMs: 1 }, registryEnv, 0);
                assert.equal(launch.native, true, `${runtime}/${selector}/${item.name} must launch Rust`);
                assert.equal(launch.command, item.command, `${runtime}/${selector}/${item.name} command`);
                assert(launch.args.includes('--telemetry-json'), `${item.name} must use the native metadata protocol`);
                assert(launch.args.includes('--once') && launch.args.includes('--dry-run'));
                assert(!launch.args.some(arg => /\.worker\.(ts|js)$/.test(arg)),
                    `${item.name} must not receive an archived entrypoint argument`);
                assert.equal(launch.options.uid, 65534);
                assert.equal(launch.options.gid, 65534);
            }
        }
    }
} finally {
    for (const key of Object.values(SELECTORS)) delete process.env[key];
}
// 3b. RAID_SESSIONS_RUNTIME was never implemented. This stale key must be inert
// in both runtimes and must not imply a restorable TypeScript raid-sessions worker.
for (const runtime of ['node', 'tsx']) {
    const definition = WORKERS.find(worker => worker.name === NATIVE_ONLY.name);
    for (const value of ['typescript', 'rust', '1', '']) {
        process.env[NATIVE_ONLY.staleKey] = value;
        const launch = resolveWorkerLaunch(definition,
            { runtime, once: true, dryRun: true, restartDelayMs: 1 }, registryEnv, 0);
        assert.equal(launch.native, true, `${runtime}/${value}/${NATIVE_ONLY.name} must launch Rust`);
        assert.equal(launch.command, NATIVE_ONLY.command);
        assert(launch.args.includes('--telemetry-json'), `${NATIVE_ONLY.name} must use the native metadata protocol`);
        assert(!launch.args.some(arg => /\.worker\.(ts|js)$/.test(arg)),
            `${NATIVE_ONLY.name} must not receive an archived entrypoint argument`);
        assert.equal(launch.options.uid, 65534);
        assert.equal(launch.options.gid, 65534);
    }
}
delete process.env[NATIVE_ONLY.staleKey];
for (const [runtime, command, suffix] of [
    ['node', process.execPath, '/dist/workers/dashboard_activity.worker.js'],
    ['tsx', 'tsx', '/src/workers/dashboard_activity.worker.ts'],
]) {
    const definition = WORKERS.find(worker => worker.name === 'dashboard-activity');
    const launch = resolveWorkerLaunch(definition, { runtime, once: false, dryRun: false, restartDelayMs: 1 }, registryEnv, 0);
    assert.equal(launch.native, false, `${runtime} must still run active TypeScript workers`);
    assert.equal(launch.command, command);
    assert(launch.args[0].endsWith(suffix), `${runtime} TypeScript entrypoint`);
}
console.log('PASS node/tsx, every retired selector and the stale RAID_SESSIONS_RUNTIME key resolve only native Rust; active TypeScript workers stay on TypeScript');

// 4. The actual supervisor ran the real native stream child and produced work.
const client = new MongoClient(uri.href, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db(databaseName);
const schema = await import('/app/dist/schemas/stream_activity.schema.js');

const native = await waitFor(async () => {
    const rows = await records();
    const exited = new Set(rows.filter(row => row.worker === 'stream-activity' && row.event === 'exit').map(row => row.pid));
    return rows.filter(row => row.worker === 'stream-activity' && row.event === 'spawn' && row.native && !exited.has(row.pid)).at(-1);
}, 'actual supervised native stream-activity startup');
assert.equal(native.requestedCommand, '/usr/local/bin/stream_activity');
assert.equal(native.uid, 65534);
assert.equal(native.gid, 65534);
const status = await readFile(`/proc/${native.pid}/status`, 'utf8');
assert.match(status, /^Name:\s+stream_activity$/m, 'the real native stream binary must be running');
assert.match(status, /^Uid:\s+65534\s+65534\s+65534\s+65534$/m, 'the real native child must drop root');

const now = new Date();
for (const model of [schema.StreamActivitySchema, schema.StreamActivityAggregateSchema, schema.StreamActivityStateSchema]) {
    for (const [key, options] of model.schema.indexes()) {
        await db.collection(model.collection.name).createIndex(key, options);
    }
}
const events = Array.from({ length: 3 }, (_, index) => new schema.StreamActivitySchema({
    _id: `rust-only-fixture-${process.pid}-${index}`,
    channelID: 'rust-only-fixture-channel',
    session_id: new ObjectId(),
    occurredAt: new Date(now.getTime() + index),
    offset: index,
    kind: 'message',
    key: `fixture-${index}`,
    label: `Fixture message ${index}`,
    actor: `fixture-actor-${index}`,
    actorLabel: `Fixture Actor ${index}`,
    value: 1,
    processed: false,
    expiresAt: new Date(now.getTime() + 86400000),
}).toObject());
await db.collection(schema.StreamActivitySchema.collection.name).insertMany(events);
await waitFor(async () => (await db.collection(schema.StreamActivitySchema.collection.name)
    .countDocuments({ _id: { $in: events.map(event => event._id) }, processed: true })) === events.length,
'native stream-activity projection', 40000);
assert((await db.collection(schema.StreamActivityAggregateSchema.collection.name).countDocuments()) > 0,
    'native projector must persist aggregate output');
const frame = await waitFor(async () => (await records()).find(row => row.worker === 'stream-activity'
    && row.event === 'frame' && row.frame?.event === 'batch' && row.frame.success && row.frame.events >= 1),
'native stream batch metadata', 40000);
assert(frame.frame.events >= 1);
await client.close();
console.log('PASS the real supervisor ran a real native child that projected fixture activity and emitted native batch metadata');

// 5. Every native worker was supervised by its own command, never a
// process.execPath/tsx launch of an archived entrypoint.
const rows = await records();
for (const item of NATIVE) {
    // Only spawn attempts identify the requested launch. Frame/exit records do
    // not carry requestedCommand or the launch command.
    const attempts = rows.filter(row => row.worker === item.name
        && (row.event === 'spawn' || row.event === 'spawn-failed'));
    assert(attempts.length > 0, `${item.name} must be supervised`);
    for (const row of attempts) {
        assert.equal(row.requestedCommand, item.command, `${item.name} must request its native command`);
        if (row.event !== 'spawn') continue;
        if (row.native) {
            assert.equal(row.command, item.command, `${item.name} must actually launch its native binary`);
        } else {
            assert.equal(row.command, 'inert-fixture-worker', `${item.name} must stay an inert fixture double`);
        }
    }
}
for (const row of rows) {
    const args = Array.isArray(row.args) ? row.args : [];
    for (const item of NATIVE) {
        for (const retiredPath of [`/${item.file}.js`, `/${item.file}.ts`]) {
            assert(!String(row.requestedCommand).endsWith(retiredPath),
                `retired entrypoint must not be requested: ${row.requestedCommand}`);
            assert(!args.some(arg => typeof arg === 'string' && arg.endsWith(retiredPath)),
                `retired entrypoint must not be passed to a child: ${retiredPath}`);
        }
    }
}
for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let command;
    try { command = await readFile(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
    const argv = command.split('\0');
    for (const item of NATIVE) {
        for (const retiredPath of [`/${item.file}.js`, `/${item.file}.ts`]) {
            assert(!argv.some(arg => arg.endsWith(retiredPath)), `retired TypeScript child must not run: ${retiredPath}`);
        }
    }
}

// 6. ENOENT and nonzero failures restart only the same Rust child.
const enoent = await waitFor(async () => {
    const failures = (await records()).filter(row => row.worker === enoentWorker
        && row.event === 'spawn-failed' && row.code === 'ENOENT');
    return failures.length >= 2 ? failures : null;
}, 'ENOENT native restart attempts');
for (const row of enoent) assert.equal(row.requestedCommand, '/usr/local/bin/ai_usage_receipts');
const nonzero = await waitFor(async () => {
    const exits = (await records()).filter(row => row.worker === nonzeroWorker
        && row.event === 'exit' && row.code === 7);
    return exits.length >= 2 ? exits : null;
}, 'nonzero native restart attempts');
for (const row of nonzero) assert.equal(row.worker, 'roulette-completion');

const before = await attempts();
await delay(2600);
const after = await attempts();
for (const name of ['stream-activity', 'raid-analytics', 'follow-defense-baseline', 'raid-sessions']) {
    assert.equal(after[name] || 0, before[name] || 0, `${name} must not restart because another child failed`);
}
assert((after[enoentWorker] || 0) > (before[enoentWorker] || 0), 'ENOENT child must retry its native command');
assert((after[nonzeroWorker] || 0) > (before[nonzeroWorker] || 0), 'nonzero child must retry its native command');

// A real native crash must replace only that same Rust child.
const beforeKill = await attempts();
process.kill(native.pid, 'SIGKILL');
const replacement = await waitFor(async () => {
    const live = await records();
    const exited = new Set(live.filter(row => row.worker === 'stream-activity' && row.event === 'exit').map(row => row.pid));
    return live.filter(row => row.worker === 'stream-activity' && row.event === 'spawn'
        && row.native && row.pid !== native.pid && !exited.has(row.pid)).at(-1);
}, 'same native stream-activity restart');
assert.equal(replacement.requestedCommand, '/usr/local/bin/stream_activity');
assert.equal(replacement.uid, 65534);
const afterKill = await attempts();
for (const name of ['raid-analytics', 'follow-defense-baseline', 'raid-sessions']) {
    assert.equal(afterKill[name] || 0, beforeKill[name] || 0, `${name} must not restart with the crashed stream child`);
}
assert((afterKill['stream-activity'] || 0) > (beforeKill['stream-activity'] || 0),
    'the crashed native stream child must restart as Rust');
console.log('PASS ENOENT, nonzero, and a real native crash restart only the same Rust child with no TypeScript launch');
console.log('PASS rust-only cron retirement: artifacts, registry, selectors, real native work, and same-Rust recovery');
