import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NATIVE, createFixtureSpawn, diagnosticParser, assertNativeMetadata, assertSelectedNatives } from '../checks/native-cron-fixture.mjs';
import { standaloneMetricsReady } from '../checks/cron-supervisors-fixtures/telemetry-assertions.mjs';

const checks = fileURLToPath(new URL('../checks/', import.meta.url));
const FIXTURES = [
    ['stream-activity', 'stream_activity_fixture_', 'spawns.jsonl'],
    ['raid-analytics', 'raid_analytics_fixture_', 'raid-spawns.jsonl'],
    ['follow-defense-baseline', 'follow_baseline_fixture_', 'baseline-spawns.jsonl'],
    ['roulette-completion', 'roulette_completion_fixture_', 'roulette-spawns.jsonl'],
    ['ai-usage-receipts', 'ai_usage_receipts_fixture_', 'ai-usage-spawns.jsonl'],
    ['raid-sessions', 'raid_sessions_fixture_', 'raid-sessions-spawns.jsonl'],
    ['dashboard-activity', 'dashboard_activity_fixture_', 'dashboard-activity-spawns.jsonl'],
];
const options = () => ({ env: { PATH: '/usr/bin', MONGO_URI: 'mongodb://mongo:27017/fixture',
    DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' }, detached: true, uid: 65534, gid: 65534 });
const metadata = (worker, pid = 2000000000, extra = {}) => ({ event: 'spawn', worker, name: worker,
    pid, binary: NATIVE[worker], args: worker === 'stream-activity' ? ['--batch-size', '500', '--telemetry-json'] : ['--telemetry-json'],
    uid: 65534, gid: 65534, envKeys: ['MONGO_URI', 'PATH'], restartCount: 0, ...extra });
const line = row => `cron_index:${JSON.stringify(row)}\n`;
function transport() {
    const calls = [], child = new EventEmitter(); child.pid = 1999999999;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return { calls, child, spawn: (...args) => { calls.push(args); return child; } };
}

for (const [name, prefix, log] of FIXTURES) {
    test(`${name} preload intercepts entrypoint and imported bridge, excludes every native direct launch`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'saas-native-hook-'));
        try {
            const workers = path.join(directory, 'dist/workers'); await mkdir(workers, { recursive: true });
            await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
            const source = await readFile(path.join(checks, `${name}-rust-fixtures/cron-boot.mjs`), 'utf8');
            const hook = path.join(directory, 'hook.mjs'); await writeFile(hook, source.replaceAll('/tmp/saas-fixtures', directory));
            await copyFile(path.join(checks, 'native-cron-fixture.mjs'), path.join(directory, 'native-cron-fixture.mjs'));
            const body = `
                import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
                for (const command of ${JSON.stringify(Object.values(NATIVE))}) {
                    assert.throws(() => spawn(command, ['--telemetry-json'], {env:{}}), /never launch individual native/);
                }
                const fake = spawn(process.execPath, ['harmless.worker.js'], {env:{CRON_WORKER_NAME:'follow-ledger'}});
                assert(fake.pid >= 900000); await new Promise(resolve => fake.once('spawn', resolve));
                const closed = new Promise(resolve => fake.once('close', resolve)); fake.kill('SIGTERM'); await closed;
            `;
            await writeFile(path.join(workers, 'cron_native_bridge.js'), body);
            const entry = path.join(workers, 'cron.index.js'); await writeFile(entry, `import './cron_native_bridge.js';\n${body}`);
            const result = spawnSync(process.execPath, ['--import', hook, entry], {
                env: { PATH: process.env.PATH, MONGO_URI: `mongodb://mongo:27017/${prefix}hooks`,
                    DRAGONFLY_HOST: 'redis', DRAGONFLY_PORT: '6379' }, encoding: 'utf8', timeout: 5000,
            });
            assert.equal(result.status, 0, result.stderr);
            const records = (await readFile(path.join(directory, log), 'utf8')).trim().split('\n').map(JSON.parse);
            assert.equal(records.length, 2);
            assert(records.every(row => row.native === false && row.worker === 'follow-ledger' && row.pid >= 900000));
            assert(records.every(row => row.supervisor === result.pid && row.scope === 'main' && Number.isFinite(row.at)));
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    test(`${name} adapter selects only its native worker with an injected launch transport`, () => {
        const fake = transport(), records = [];
        const spawn = createFixtureSpawn({ selected: [name], record: row => records.push(row) }, fake.spawn);
        const child = spawn('/usr/local/bin/cron_index', [], options());
        assert.equal(child, fake.child); assert.equal(fake.calls.length, 1);
        const [command, args, opts] = fake.calls[0];
        assert.equal(command, '/usr/local/bin/cron_index');
        assert.deepEqual(args, ['--workers', name, '--events-json']);
        assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'inherit']);
        assert.equal(opts.detached, true); assert.equal(opts.uid, 65534); assert.equal(opts.gid, 65534);
        child.stdout.emit('data', Buffer.from(line(metadata(name))));
        const native = records.find(row => row.native); assert.equal(native.worker, name);
        assert.equal(native.pid, 2000000000); assert.equal(native.rustSupervisor, fake.child.pid);
        assert.deepEqual(native.envKeys, ['MONGO_URI', 'PATH']);
        assertSelectedNatives(records.map(row => ({ supervisor: process.pid, ...row })), [name]);
        assert.throws(() => spawn('/usr/local/bin/cron_index', [], options()), /exactly one/);
    });
}

test('bridge allowlist refuses Node options, unrelated secrets and unsupported selection arguments before spawn', () => {
    for (const bad of [{ ...options(), detached: false }, { ...options(), uid: 0 },
        { ...options(), env: { ...options().env, NODE_OPTIONS: '--import=PRIVATE' } },
        { ...options(), env: { ...options().env, SECRET_KEY: 'PRIVATE' } }]) {
        const fake = transport(), spawn = createFixtureSpawn({ selected: ['stream-activity'], record() {} }, fake.spawn);
        assert.throws(() => spawn('/usr/local/bin/cron_index', [], bad)); assert.equal(fake.calls.length, 0);
    }
    const fake = transport(), spawn = createFixtureSpawn({ selected: ['stream-activity'], record() {} }, fake.spawn);
    assert.throws(() => spawn('/usr/local/bin/cron_index', ['--workers', 'dashboard-activity'], options()));
    assert.equal(fake.calls.length, 0);
});

test('diagnostics preserve batch/health generation, worker env and separate Node/Rust identities', () => {
    const records = [], parse = diagnosticParser({ selected: ['stream-activity'], rustPid: 1999999999, record: row => records.push(row) });
    const first = line(metadata('stream-activity'));
    for (const character of first) parse(character);
    const batch = { event: 'batch', events: 1, durationMs: 2, success: true };
    const health = { event: 'health', success: true, hasPending: false };
    parse(line({ event: 'batch', worker: 'stream-activity', frame: batch }));
    parse(line({ event: 'health', worker: 'stream-activity', frame: health }));
    assert.equal(records[1].pid, 2000000000); assert.deepEqual(records[1].frame, batch);
    assert.equal(records[2].pid, 2000000000); assert.deepEqual(records[2].frame, health);
    parse(line({ event: 'exit', worker: 'stream-activity', pid: 2000000000, code: 1, signal: 9, restarting: true }));
    assert.equal(records.at(-1).signal, 'SIGKILL'); assert.equal(records.at(-1).code, null);
    parse(line(metadata('stream-activity', 2000000001, { restartCount: 1 })));
    assert.throws(() => parse(line({ event: 'batch', worker: 'stream-activity', pid: 2000000000, frame: batch })), /current native generation/);
    parse(line({ event: 'batch', worker: 'stream-activity', frame: batch }));
    assert.equal(records.at(-1).pid, 2000000001);
});

test('diagnostic buffer discards oversized lines and unterminated tails without recording private text', () => {
    const records = [], parse = diagnosticParser({ selected: ['stream-activity'], rustPid: 1999999999, record: row => records.push(row) });
    parse('PRIVATE_RAW_STDOUT\n');
    for (let i = 0; i < 100; i++) parse('PRIVATE_PAYLOAD'.repeat(1024));
    parse('\n' + line(metadata('stream-activity')));
    parse('cron_index:{"private":"UNTERMINATED');
    assert.equal(records.length, 1); assert.doesNotMatch(JSON.stringify(records), /PRIVATE|UNTERMINATED/);
});

test('unselected diagnostic, unsafe worker metadata and unsanitized errors fail closed', () => {
    for (const row of [metadata('raid-analytics'), metadata('stream-activity', 2000000000, { uid: 0 }),
        metadata('stream-activity', 2000000000, { envKeys: ['CLIENT_SECRET'] }),
        metadata('stream-activity', 2000000000, { binary: '/bin/sh' }),
        { event: 'error', worker: 'stream-activity', step: 'spawn', code: 'PRIVATE database://value' }]) {
        const records = [], parse = diagnosticParser({ selected: ['stream-activity'], rustPid: 1999999999, record: row => records.push(row) });
        assert.throws(() => parse(line(row))); assert.deepEqual(records, []);
    }
    assert.throws(() => assertNativeMetadata(metadata('stream-activity', 1, { args: ['--telemetry-json'] })));
});

test('real Rust ENOENT/nonzero diagnostics are translated without Node per-worker mocks', () => {
    const records = [], selected = ['stream-activity', 'ai-usage-receipts', 'roulette-completion'];
    const parse = diagnosticParser({ selected, rustPid: 1999999999, record: row => records.push(row), frameEvent: 'frame' });
    parse(line({ event: 'error', name: 'ai-usage-receipts', worker: 'ai-usage-receipts', step: 'spawn', code: 'ENOENT' }));
    parse(line({ event: 'exit', name: 'ai-usage-receipts', worker: 'ai-usage-receipts', pid: null, code: 1, signal: null, failedSpawn: true, restarting: true }));
    parse(line(metadata('roulette-completion')));
    parse(line({ event: 'exit', worker: 'roulette-completion', pid: 2000000000, code: 7, signal: null, restarting: true }));
    assert.equal(records[0].event, 'spawn-failed'); assert.equal(records[0].requestedCommand, NATIVE['ai-usage-receipts']);
    assert.equal(records[1].restarting, true); assert.equal(records.at(-1).code, 7);
    assert(records.every(row => !String(row.command).includes('inert')));
});

test('preloads reject production aliases before any Rust launch or candidate binary fault', async () => {
    for (const name of [...FIXTURES.map(([name]) => `${name}-rust`), 'rust-only-cron']) {
        const directory = await mkdtemp(path.join(tmpdir(), 'saas-native-guard-'));
        try {
            await mkdir(path.join(directory, 'dist/workers'), { recursive: true });
            await copyFile(path.join(checks, 'native-cron-fixture.mjs'), path.join(directory, 'native-cron-fixture.mjs'));
            await copyFile(path.join(checks, `${name}-fixtures/cron-boot.mjs`), path.join(directory, 'hook.mjs'));
            const entry = path.join(directory, 'dist/workers/cron.index.js'); await writeFile(entry, 'throw new Error("MUST_NOT_RUN")');
            const result = spawnSync(process.execPath, ['--import', path.join(directory, 'hook.mjs'), entry], {
                env: { PATH: process.env.PATH, MONGO_URI: 'mongodb://production:27017/live', DRAGONFLY_HOST: 'production', DRAGONFLY_PORT: '6379' },
                encoding: 'utf8', timeout: 5000,
            });
            assert.notEqual(result.status, 0); assert.match(result.stderr, /requires disposable Mongo\/Redis/);
            assert.doesNotMatch(result.stderr, /MUST_NOT_RUN/);
        } finally { await rm(directory, { recursive: true, force: true }); }
    }
});

test('once-mode TS doubles finish so Node can aggregate the real Rust result', async () => {
    const fake = transport(), records = [];
    const spawn = createFixtureSpawn({ selected: ['stream-activity'], record: row => records.push(row) }, fake.spawn);
    const child = spawn(process.execPath, ['goals.worker.js', '--once'], { env: { CRON_WORKER_NAME: 'goals' } });
    const exit = await new Promise(resolve => child.once('close', code => resolve(code)));
    assert.equal(exit, 0); assert.equal(fake.calls.length, 0);
    assert.equal(records.length, 1); assert.equal(records[0].native, false);
});

test('harmless real TS control preserves once flags and strips every inherited secret', () => {
    const fake = transport(), records = [];
    const spawn = createFixtureSpawn({ selected: ['stream-activity'], typescriptWorker: 'follow-ledger',
        typescriptEntry: '/fixture/typescript-child.mjs', record: row => records.push(row) }, fake.spawn);
    spawn('tsx', ['/app/src/workers/follow_ledger.worker.ts', '--once'], { env: {
        CRON_WORKER_NAME: 'follow-ledger', NODE_OPTIONS: '--import=PRIVATE', SECRET_KEY: 'PRIVATE',
    } });
    const [command, args, options] = fake.calls[0];
    assert.equal(command, process.execPath); assert.deepEqual(args, ['/fixture/typescript-child.mjs', '--once']);
    assert.deepEqual(Object.keys(options.env).sort(), ['CRON_WORKER_NAME', 'PATH']);
    assert.equal(records[0].actualTypescript, true);
});

test('diagnostic progress rejects private values and fields without retaining them', () => {
    for (const frame of [
        { event: 'batch', events: 1, durationMs: 2, success: true, secret: 'PRIVATE' },
        { event: 'batch', events: 'PRIVATE', durationMs: 2, success: true },
        { event: 'health', success: true, hasPending: false, checkpointSeq: 'PRIVATE' },
    ]) {
        const records = [], parse = diagnosticParser({ selected: ['stream-activity'], rustPid: 1999999999, record: row => records.push(row) });
        parse(line(metadata('stream-activity')));
        assert.throws(() => parse(line({ event: frame.event, worker: 'stream-activity', frame })));
        assert.equal(records.length, 1); assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
    }
});

test('AI receipts preserves its scoped loopback Redis reconnect exception and rejects it elsewhere', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'saas-native-relay-'));
    try {
        await mkdir(path.join(directory, 'dist/workers'), { recursive: true });
        await copyFile(path.join(checks, 'native-cron-fixture.mjs'), path.join(directory, 'native-cron-fixture.mjs'));
        const source = await readFile(path.join(checks, 'ai-usage-receipts-rust-fixtures/cron-boot.mjs'), 'utf8');
        const hook = path.join(directory, 'hook.mjs'); await writeFile(hook, source.replaceAll('/tmp/saas-fixtures', directory));
        const entry = path.join(directory, 'dist/workers/cron.index.js');
        await writeFile(entry, `import {spawn} from 'node:child_process'; const child = spawn(process.execPath, [], {env:{CRON_WORKER_NAME:'goals'}}); child.kill();`);
        for (const [scope, port, expected] of [['reconnect', '54321', 0], ['main', '54321', 1], ['reconnect', '0', 1]]) {
            const result = spawnSync(process.execPath, ['--import', hook, entry], {
                env: { PATH: process.env.PATH, MONGO_URI: 'mongodb://mongo:27017/ai_usage_receipts_fixture_relay',
                    DRAGONFLY_HOST: '127.0.0.1', DRAGONFLY_PORT: port, AI_USAGE_RECEIPTS_FIXTURE_SCOPE: scope },
                encoding: 'utf8', timeout: 5000,
            });
            assert.equal(result.status, expected, result.stderr);
        }
        const records = (await readFile(path.join(directory, 'ai-usage-spawns.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(records.length, 1); assert.equal(records[0].scope, 'reconnect');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('standalone telemetry permits and validates only the fixed supervisor dropped metric', () => {
    const workers = ['roulette-completion', 'raid-sessions'];
    const metrics = workers.flatMap(name => {
        const prefix = `${name.replaceAll('-', '_')}_rust.`;
        return [
            { name: prefix + 'rss_bytes', kind: 'runtime', channel: '', max: 4096 },
            { name: prefix + 'cpu_cores', kind: 'runtime', channel: '', max: 0 },
            { name: prefix + (name === 'roulette-completion' ? 'batch_channels' : 'batch_items'),
                kind: 'worker', channel: '', sum: 3, count: 1 },
        ];
    });
    const dropped = { name: 'cron_index_rust.telemetry_dropped', kind: 'runtime', channel: '', outcome: 'ok', count: 1, sum: 0, max: 0 };
    assert.equal(standaloneMetricsReady(metrics, workers), false, 'periodic supervisor flush must be observed');
    assert.equal(standaloneMetricsReady([...metrics, dropped], workers), true);
    assert.equal(standaloneMetricsReady([...metrics, { ...dropped, sum: 7, max: 7 }], workers), true);
    for (const invalid of [{ name: 'cron_index_rust.PRIVATE_LABEL' }, { channel: 'PRIVATE_CHANNEL' },
        { kind: 'worker' }, { outcome: 'error' }, { count: 0 }, { sum: -1 }, { max: NaN },
        { sum: 1e15 + 1 }, { sum: 1.5 }, { sum: 1, max: 2 }]) {
        assert.throws(() => standaloneMetricsReady([...metrics, { ...dropped, ...invalid }], workers));
    }
});
