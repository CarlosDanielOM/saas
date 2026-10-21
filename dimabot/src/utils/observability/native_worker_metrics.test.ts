import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { NativeCpuTracker, nativeProgressParser, parseNativeRss, parseNativeStat, startNativeWorkerMetrics, type NativeSnapshot } from './native_worker_metrics.js';
import { observe, telemetryTesting } from './telemetry.js';

function stat(comm: string, user = '100', system = '50', start = '1234', state = 'S'): string {
    const fields = Array<string>(20).fill('0');
    fields[0] = state; fields[11] = user; fields[12] = system; fields[19] = start;
    return `42 (${comm}) ${fields.join(' ')}`;
}
const snapshot = (cpuTicks: bigint, startTicks = 1234n): NativeSnapshot => ({ startTicks, cpuTicks, rssBytes: 4096 });

test('proc fields handle parentheses, use user plus system time and reject missing/dead metadata', () => {
    assert.deepEqual(parseNativeStat(stat('rust (nested) ) name'), 42), { cpuTicks: 150n, startTicks: 1234n });
    assert.equal(parseNativeStat(stat('native'), 99), undefined);
    assert.equal(parseNativeStat(stat('native', 'bad'), 42), undefined);
    assert.equal(parseNativeStat(stat('native', '1', '2', '3', 'Z'), 42), undefined);
    assert.equal(parseNativeStat('42 (broken) S 0', 42), undefined);
    assert.equal(parseNativeRss('Name:\trust\nPid:\t42\nVmRSS:\t12 kB\n', 42), 12288);
    assert.equal(parseNativeRss('Pid:\t43\nVmRSS:\t12 kB\n', 42), undefined);
    assert.equal(parseNativeRss('Pid:\t42\n', 42), undefined);
});

test('CPU is normalized to one core; reset, gaps and PID reuse never create spurious deltas', () => {
    const tracker = new NativeCpuTracker();
    assert.deepEqual(tracker.sample(snapshot(100n), 0, 100), { rssBytes: 4096 });
    assert.deepEqual(tracker.sample(snapshot(300n), 1000, 100), { rssBytes: 4096, cpuCores: 2 });
    assert.deepEqual(tracker.sample(snapshot(10n), 2000, 100), { rssBytes: 4096 });
    assert.equal(tracker.sample(snapshot(60n), 3000, 100)?.cpuCores, 0.5);
    tracker.missing();
    assert.deepEqual(tracker.sample(snapshot(160n), 5000, 100), { rssBytes: 4096 });
    assert.deepEqual(tracker.sample(snapshot(200n), 6000, undefined), { rssBytes: 4096 });
    assert.equal(tracker.sample(snapshot(250n, 9999n), 7000, 100), undefined);
    assert.equal(tracker.sample(snapshot(300n), 8000, 100), undefined, 'identity fence stays closed after PID reuse');
});

test('sampler never overlaps reads and stop fences a pending read without a zero final sample', async () => {
    let reads = 0, resolveRead!: (value: NativeSnapshot) => void;
    const samples: unknown[] = [];
    const stop = startNativeWorkerMetrics(42, {
        read: async () => { reads++; return new Promise<NativeSnapshot>(resolve => { resolveRead = resolve; }); },
        ticks: async () => 100, observe: (...args) => { samples.push(args); }, intervalMs: 2,
    });
    await delay(15);
    assert.equal(reads, 1);
    stop(); stop(); resolveRead(snapshot(100n));
    await delay(15);
    assert.equal(reads, 1); assert.deepEqual(samples, []);
});

test('progress frames are bounded, split-safe and export only validated metadata', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); });
    const frame = (events: unknown, durationMs: unknown, success: unknown = true) =>
        `stream_activity:${JSON.stringify({ event: 'batch', events, durationMs, success })}\n`;
    const valid = frame(500, 12);
    feed(Buffer.from(valid.slice(0, 10))); feed(Buffer.from(valid.slice(10)));
    feed(frame(0, 1)); feed(frame(0, 2, false));
    feed(frame('secret', 1)); feed(frame(1001, 1)); feed(frame(1.5, 1));
    feed(frame(1, -1)); feed(frame(1, 300001)); feed(frame(1, 1, false));
    feed('stream_activity:{invalid}\nprivate output secret\n');
    feed(`stream_activity:${'x'.repeat(2000)}\n`);
    feed(frame(1, 3));
    assert.deepEqual(samples, [
        ['worker', 'stream_activity_rust.batch_events', 500, 'ok'], ['queue_run', 'stream_activity_rust.project_batch', 12, 'ok'],
        ['worker', 'stream_activity_rust.batch_events', 0, 'idle'], ['queue_run', 'stream_activity_rust.project_batch', 1, 'idle'],
        ['worker', 'stream_activity_rust.batch_events', 0, 'error'], ['queue_run', 'stream_activity_rust.project_batch', 2, 'error'],
        ['worker', 'stream_activity_rust.batch_events', 1, 'ok'], ['queue_run', 'stream_activity_rust.project_batch', 3, 'ok'],
    ]);
    assert(!JSON.stringify(samples).includes('secret'));
});

test('raid frames count only zero or one refreshed channel and cannot spoof stream metrics', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'raid-analytics');
    const frame = (events: unknown, durationMs: unknown, success: unknown = true) =>
        `raid_analytics:${JSON.stringify({ event: 'batch', events, durationMs, success })}\n`;
    const valid = frame(1, 12);
    feed(Buffer.from(valid.slice(0, 10))); feed(Buffer.from(valid.slice(10)));
    feed(frame(0, 1)); feed(frame(0, 2, false));
    feed(frame(2, 1)); feed(frame(-1, 1)); feed(frame(0.5, 1)); feed(frame('secret', 1));
    feed(frame(1, -1)); feed(frame(1, 1, false));
    feed(frame(1, null)); feed(frame(1, 3, 'true'));
    feed('stream_activity:{"event":"batch","events":1,"durationMs":3,"success":true}\n');
    feed('raid_analytics:{invalid}\nprivate output secret\n');
    feed(`raid_analytics:${'x'.repeat(2000)}\n`); feed(frame(1, 300001));
    assert.deepEqual(samples, [
        ['worker', 'raid_analytics_rust.batch_channels', 1, 'ok'], ['queue_run', 'raid_analytics_rust.project_batch', 12, 'ok'],
        ['worker', 'raid_analytics_rust.batch_channels', 0, 'idle'], ['queue_run', 'raid_analytics_rust.project_batch', 1, 'idle'],
        ['worker', 'raid_analytics_rust.batch_channels', 0, 'error'], ['queue_run', 'raid_analytics_rust.project_batch', 2, 'error'],
        ['worker', 'raid_analytics_rust.batch_channels', 1, 'ok'], ['queue_run', 'raid_analytics_rust.project_batch', 300001, 'ok'],
    ]);
});

test('raid sampler uses its own resource prefix and permanently fences PID reuse', async () => {
    let reads = 0;
    const samples: unknown[][] = [];
    const stop = startNativeWorkerMetrics(42, {
        read: async () => snapshot(BigInt(++reads * 100), reads > 2 ? 9999n : 1234n),
        ticks: async () => 100, now: () => reads * 1000, intervalMs: 2,
        observe: (...args) => { samples.push(args); },
    }, 'raid-analytics');
    await delay(40); stop();
    assert.equal(reads, 3);
    assert.deepEqual(samples, [
        ['runtime', 'raid_analytics_rust.rss_bytes', 4096],
        ['runtime', 'raid_analytics_rust.rss_bytes', 4096], ['runtime', 'raid_analytics_rust.cpu_cores', 1],
    ]);
});

const raidFrame = (row: Record<string, unknown>): string => `raid_analytics:${JSON.stringify(row)}\n`;

test('raid phase durations preserve failed attempts, omit unreached phases and retain batch compatibility', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'raid-analytics');
    feed(raidFrame({ event: 'batch', events: 1, durationMs: 100, success: true, phases: {
        claimMs: 1, followQueriesMs: 2, followWriteMs: 3, period7Ms: 4,
        period30Ms: 5, reciprocityMs: 6, publishMs: 7, releaseMs: 8,
    } }));
    feed(raidFrame({ event: 'batch', events: 0, durationMs: 9, success: false, phases: { claimMs: 0, followQueriesMs: 9 } }));
    feed(raidFrame({ event: 'batch', events: 0, durationMs: 1, success: true, phases: { claimMs: 1 } }));
    feed(raidFrame({ event: 'batch', events: 1, durationMs: 2, success: true }));
    assert.deepEqual(samples, [
        ['worker', 'raid_analytics_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'raid_analytics_rust.project_batch', 100, 'ok'],
        ...['claimMs', 'followQueriesMs', 'followWriteMs', 'period7Ms', 'period30Ms', 'reciprocityMs', 'publishMs', 'releaseMs']
            .map((name, index) => ['queue_run', `raid_analytics_rust.phase.${name}`, index + 1, 'ok', '']),
        ['worker', 'raid_analytics_rust.batch_channels', 0, 'error'],
        ['queue_run', 'raid_analytics_rust.project_batch', 9, 'error'],
        ['queue_run', 'raid_analytics_rust.phase.claimMs', 0, 'error', ''],
        ['queue_run', 'raid_analytics_rust.phase.followQueriesMs', 9, 'error', ''],
        ['worker', 'raid_analytics_rust.batch_channels', 0, 'idle'],
        ['queue_run', 'raid_analytics_rust.project_batch', 1, 'idle'],
        ['queue_run', 'raid_analytics_rust.phase.claimMs', 1, 'idle', ''],
        ['worker', 'raid_analytics_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'raid_analytics_rust.project_batch', 2, 'ok'],
    ]);
});

test('raid health distinguishes empty, unknown, partial and failed query observations', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'raid-analytics');
    const healthy = raidFrame({ event: 'health', success: true, dueChannels: 4, oldestDueAgeMs: 1200, lastSuccessAgeMs: 4500 });
    feed(Buffer.from(healthy.slice(0, 31))); feed(healthy.slice(31, -1));
    assert.equal(samples.length, 0, 'incomplete frames emit nothing');
    feed('\n');
    feed(raidFrame({ event: 'health', success: true, dueChannels: 0 }));
    feed(raidFrame({ event: 'health', success: true, dueChannels: null, oldestDueAgeMs: 12, lastSuccessAgeMs: null }));
    feed(raidFrame({ event: 'health', success: false }));
    feed(raidFrame({ event: 'health', success: false, dueChannels: null, oldestDueAgeMs: null, lastSuccessAgeMs: 77 }));
    assert.deepEqual(samples, [
        ['worker', 'raid_analytics_rust.health_query', 1, 'ok', ''],
        ['worker', 'raid_analytics_rust.backlog_channels', 4, 'ok', ''],
        ['worker', 'raid_analytics_rust.oldest_due_age_ms', 1200, 'ok', ''],
        ['worker', 'raid_analytics_rust.last_success_age_ms', 4500, 'ok', ''],
        ['worker', 'raid_analytics_rust.health_query', 1, 'ok', ''],
        ['worker', 'raid_analytics_rust.backlog_channels', 0, 'ok', ''],
        ['worker', 'raid_analytics_rust.health_query', 1, 'ok', ''],
        ['worker', 'raid_analytics_rust.oldest_due_age_ms', 12, 'ok', ''],
        ['worker', 'raid_analytics_rust.health_query', 0, 'ok', ''],
        ['worker', 'raid_analytics_rust.health_errors', 1, 'error', ''],
        ['worker', 'raid_analytics_rust.health_query', 0, 'ok', ''],
        ['worker', 'raid_analytics_rust.health_errors', 1, 'error', ''],
        ['worker', 'raid_analytics_rust.last_success_age_ms', 77, 'ok', ''],
    ]);
});

test('raid schema rejects malformed values and unbounded or private labels without partial exports', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'raid-analytics');
    const batch = { event: 'batch', events: 1, durationMs: 10, success: true };
    const health = { event: 'health', success: true };
    for (const phases of [null, [], 'claimMs', { channelId: 12 }, { query: 'private' },
        { claimMs: -1 }, { claimMs: '1' }, { claimMs: null }, { claimMs: 1e15 + 1 },
        { claimMs: 1, followQueriesMs: false }]) feed(raidFrame({ ...batch, phases }));
    for (const field of ['dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs']) {
        for (const value of [-1, '1', true, {}, [], 1e15 + 1]) feed(raidFrame({ ...health, [field]: value }));
    }
    feed(raidFrame({ ...health, dueChannels: .5 }));
    feed(raidFrame({ ...health, dueChannels: 0, oldestDueAgeMs: 0 }));
    feed(raidFrame({ event: 'health', success: false, dueChannels: 0 }));
    feed(raidFrame({ event: 'health', success: false, oldestDueAgeMs: 1 }));
    feed(raidFrame({ event: 'health' }));
    feed(raidFrame({ ...health, success: 'true' }));
    for (const row of [batch, health]) {
        feed(raidFrame({ ...row, channelId: 'private' }));
        feed(raidFrame({ ...row, query: 'private' }));
        feed(raidFrame({ ...row, name: 'attacker-controlled' }));
    }
    feed('raid_analytics:{"event":"batch","events":1,"durationMs":2,"success":true,"phases":{"claimMs":1e309}}\n');
    feed('raid_analytics:{"event":"health","success":true,"dueChannels":1e309}\n');
    feed('raid_analytics:{"event":"health","success":true,"oldestDueAgeMs":1e309}\n');
    feed('raid_analytics:{"event":"health","success":true,"lastSuccessAgeMs":1e309}\n');
    feed('raid_analytics:null\nraid_analytics:[]\nraid_analytics:{"event":"health"}\n');
    feed(`raid_analytics:${' '.repeat(1024)}${JSON.stringify(health)}\n`);
    assert.deepEqual(samples, []);
    feed(raidFrame({ ...batch, phases: { claimMs: 1e15 } }));
    assert.equal(samples.length, 3, 'oversized-frame discard recovers at the next newline');
});

test('stream parser ignores raid health and phases while preserving its original batch output', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); });
    feed(raidFrame({ event: 'health', success: true, dueChannels: 9 }));
    feed('stream_activity:{"event":"health","success":true,"dueChannels":9}\n');
    feed('stream_activity:{"event":"batch","events":1,"durationMs":2,"success":true,"phases":{"claimMs":3}}\n');
    feed('stream_activity:{"event":"batch","events":1,"durationMs":2,"success":true}\n');
    assert.deepEqual(samples, [
        ['worker', 'stream_activity_rust.batch_events', 1, 'ok'],
        ['queue_run', 'stream_activity_rust.project_batch', 2, 'ok'],
    ]);
});

test('raid metadata uses the existing bounded telemetry aggregation and keeps health failures separate', () => {
    telemetryTesting.reset(); telemetryTesting.enable();
    try {
        const feed = nativeProgressParser(observe, 'raid-analytics');
        feed(raidFrame({ event: 'health', success: true, dueChannels: 6, oldestDueAgeMs: 90 }));
        feed(raidFrame({ event: 'health', success: false, lastSuccessAgeMs: 100 }));
        feed(raidFrame({ event: 'batch', events: 0, durationMs: 17, success: false, phases: { followQueriesMs: 17 } }));
        const { metrics, spans, logs } = telemetryTesting.snapshot();
        assert.deepEqual(spans, []); assert.deepEqual(logs, []);
        assert.equal(metrics.length, 8);
        assert(metrics.every(row => row.channel === '' && row.name.startsWith('raid_analytics_rust.') && row.histogram.reduce((a, b) => a + b, 0) === row.count));
        assert.equal(metrics.find(row => row.name.endsWith('.backlog_channels'))?.sum, 6);
        assert.equal(metrics.find(row => row.name.endsWith('.oldest_due_age_ms'))?.sum, 90);
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.count, 2);
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.sum, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.count, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.outcome, 'error');
        assert.equal(metrics.find(row => row.name.endsWith('.last_success_age_ms'))?.outcome, 'ok');
        assert(!metrics.some(row => row.kind === 'lifecycle'), 'health query errors must never become worker restarts');
    } finally { telemetryTesting.reset(); telemetryTesting.stop(); }
});

test('baseline protocol validates bounded private-free batches independently of other native workers', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'follow-defense-baseline');
    const frame = (row: Record<string, unknown>) => `follow_defense_baseline:${JSON.stringify(row)}\n`;
    const valid = { event: 'batch', events: 1, durationMs: 20, success: true };
    for (const row of [{ ...valid, events: 2 }, { ...valid, durationMs: 300001 }, { ...valid, success: false },
        { ...valid, channelID: 'private' }, { ...valid, phases: { channelID: 1 } }, { ...valid, events: .5 },
        { ...valid, durationMs: -1 }, { ...valid, success: 'true' }]) feed(frame(row));
    feed(`follow_defense_baseline:${' '.repeat(1100)}{}\n`);
    feed('raid_analytics:{"event":"batch","events":1,"durationMs":2,"success":true}\n');
    assert.deepEqual(samples, []);
    feed(frame(valid).slice(0, 25)); assert.deepEqual(samples, []);
    feed(frame(valid).slice(25));
    feed(frame({ ...valid, events: 0, success: false }));
    feed(frame({ ...valid, events: 0 }));
    assert.deepEqual(samples, [
        ['worker', 'follow_defense_baseline_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 20, 'ok'],
        ['worker', 'follow_defense_baseline_rust.batch_channels', 0, 'error'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 20, 'error'],
        ['worker', 'follow_defense_baseline_rust.batch_channels', 0, 'idle'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 20, 'idle'],
    ]);
});

test('baseline sampler emits only its registered runtime metric names', async () => {
    let reads = 0;
    const samples: unknown[][] = [];
    const stop = startNativeWorkerMetrics(42, {
        read: async () => snapshot(BigInt(++reads * 100)), ticks: async () => 100,
        now: () => reads * 1000, intervalMs: 2, observe: (...args) => { samples.push(args); },
    }, 'follow-defense-baseline');
    await delay(15); stop();
    assert(samples.some(row => row[1] === 'follow_defense_baseline_rust.rss_bytes'));
    assert(samples.some(row => row[1] === 'follow_defense_baseline_rust.cpu_cores'));
    assert(samples.every(row => String(row[1]).startsWith('follow_defense_baseline_rust.')));
});

const baselineFrame = (row: Record<string, unknown>): string => `follow_defense_baseline:${JSON.stringify(row)}\n`;
const baselinePhases = ['queueMs', 'claimMs', 'ledgerMs', 'streamsMs', 'attacksMs', 'publishMs', 'rescheduleMs'];

test('baseline phases report every reached attempt with its enclosing batch outcome', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'follow-defense-baseline');
    const phases = Object.fromEntries(baselinePhases.map((name, index) => [name, index]));
    feed(baselineFrame({ event: 'batch', events: 1, durationMs: 7, success: true, phases }));
    feed(baselineFrame({ event: 'batch', events: 0, durationMs: 2, success: false, phases: { queueMs: 0, ledgerMs: 2 } }));
    feed(baselineFrame({ event: 'batch', events: 0, durationMs: 1, success: true, phases: { queueMs: 1 } }));
    feed(baselineFrame({ event: 'batch', events: 1, durationMs: 1, success: true }));
    assert.deepEqual(samples, [
        ['worker', 'follow_defense_baseline_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 7, 'ok'],
        ...baselinePhases.map((name, index) => ['queue_run', `follow_defense_baseline_rust.phase.${name}`, index, 'ok', '']),
        ['worker', 'follow_defense_baseline_rust.batch_channels', 0, 'error'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 2, 'error'],
        ['queue_run', 'follow_defense_baseline_rust.phase.queueMs', 0, 'error', ''],
        ['queue_run', 'follow_defense_baseline_rust.phase.ledgerMs', 2, 'error', ''],
        ['worker', 'follow_defense_baseline_rust.batch_channels', 0, 'idle'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 1, 'idle'],
        ['queue_run', 'follow_defense_baseline_rust.phase.queueMs', 1, 'idle', ''],
        ['worker', 'follow_defense_baseline_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'follow_defense_baseline_rust.project_batch', 1, 'ok'],
    ]);
});

test('baseline health preserves unknown and mixed readings without reporting child restarts', () => {
    telemetryTesting.reset(); telemetryTesting.enable();
    try {
        const feed = nativeProgressParser(observe, 'follow-defense-baseline');
        const first = baselineFrame({ event: 'health', success: true, dueChannels: 6, oldestDueAgeMs: 90 });
        feed(first.slice(0, 12)); assert.equal(telemetryTesting.snapshot().metrics.length, 0);
        feed(first.slice(12));
        feed(baselineFrame({ event: 'health', success: true, dueChannels: 0 }));
        feed(baselineFrame({ event: 'health', success: true }));
        feed(baselineFrame({ event: 'health', success: false, lastSuccessAgeMs: 100 }));
        const { metrics, spans, logs } = telemetryTesting.snapshot();
        assert.deepEqual(spans, []); assert.deepEqual(logs, []);
        assert(metrics.every(row => row.channel === '' && row.name.startsWith('follow_defense_baseline_rust.')));
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.count, 4);
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.sum, 3);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.count, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.outcome, 'error');
        assert.equal(metrics.find(row => row.name.endsWith('.backlog_channels'))?.count, 2);
        assert.equal(metrics.find(row => row.name.endsWith('.backlog_channels'))?.sum, 6);
        assert.equal(metrics.find(row => row.name.endsWith('.oldest_due_age_ms'))?.count, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.last_success_age_ms'))?.sum, 100);
        assert(!metrics.some(row => row.kind === 'lifecycle' || /\.(errors|restarts)$/.test(row.name)));
    } finally { telemetryTesting.reset(); telemetryTesting.stop(); }
});

test('baseline strict metadata rejects malformed private or unreached fields as a complete frame', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'follow-defense-baseline');
    const batch = { event: 'batch', events: 1, durationMs: 10, success: true };
    const health = { event: 'health', success: true };
    for (const phases of [null, [], 'queueMs', { channelId: 12 }, { query: 'private' }, { followQueriesMs: 1 },
        ...[-1, '1', null, false, 1e15 + 1].map(value => ({ ledgerMs: value }))]) feed(baselineFrame({ ...batch, phases }));
    for (const field of ['dueChannels', 'oldestDueAgeMs', 'lastSuccessAgeMs']) {
        for (const value of [-1, '1', true, {}, [], 1e15 + 1]) feed(baselineFrame({ ...health, [field]: value }));
        feed(`follow_defense_baseline:{"event":"health","success":true,"${field}":1e309}\n`);
    }
    for (const row of [{ ...health, dueChannels: .5 }, { ...health, dueChannels: 0, oldestDueAgeMs: 0 },
        { event: 'health', success: false, dueChannels: 0 }, { event: 'health', success: false, oldestDueAgeMs: 1 },
        { event: 'health' }, { ...health, success: 'true' }]) feed(baselineFrame(row));
    for (const row of [batch, health]) for (const field of ['channelId', 'query', 'name']) feed(baselineFrame({ ...row, [field]: 'private' }));
    feed('follow_defense_baseline:{"event":"batch","events":1,"durationMs":2,"success":true,"phases":{"queueMs":1e309}}\n');
    feed(`follow_defense_baseline:${' '.repeat(1024)}${JSON.stringify(health)}\n`);
    assert.deepEqual(samples, []);
    feed(baselineFrame({ ...batch, phases: { queueMs: 1e15 } }));
    assert.equal(samples.length, 3);
});

const streamFrame = (row: Record<string, unknown>): string => `stream_activity:${JSON.stringify(row)}\n`;

test('stream health distinguishes empty and unknown progress, pending work and failed probes', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); });
    const initial = streamFrame({ event: 'health', success: true, hasPending: false });
    feed(Buffer.from(initial.slice(0, 31))); feed(initial.slice(31, -1));
    assert.deepEqual(samples, []);
    feed('\n');
    feed(streamFrame({ event: 'health', success: true, hasPending: true, oldestPendingAgeMs: 1200,
        checkpointSeq: 3, activeBatchEvents: 4, lastSuccessAgeMs: 4500 }));
    feed(streamFrame({ event: 'health', success: true, hasPending: false, checkpointSeq: 4, activeBatchEvents: 0, lastSuccessAgeMs: 0 }));
    feed(streamFrame({ event: 'health', success: false }));
    feed(streamFrame({ event: 'health', success: false, lastSuccessAgeMs: 77 }));
    assert.deepEqual(samples, [
        ['worker', 'stream_activity_rust.health_query', 1, 'ok', ''],
        ['worker', 'stream_activity_rust.pending_work', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.health_query', 1, 'ok', ''],
        ['worker', 'stream_activity_rust.pending_work', 1, 'ok', ''],
        ['worker', 'stream_activity_rust.oldest_pending_age_ms', 1200, 'ok', ''],
        ['worker', 'stream_activity_rust.checkpoint_seq', 3, 'ok', ''],
        ['worker', 'stream_activity_rust.active_batch_events', 4, 'ok', ''],
        ['worker', 'stream_activity_rust.last_success_age_ms', 4500, 'ok', ''],
        ['worker', 'stream_activity_rust.health_query', 1, 'ok', ''],
        ['worker', 'stream_activity_rust.pending_work', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.checkpoint_seq', 4, 'ok', ''],
        ['worker', 'stream_activity_rust.active_batch_events', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.last_success_age_ms', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.health_query', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.health_errors', 1, 'error', ''],
        ['worker', 'stream_activity_rust.health_query', 0, 'ok', ''],
        ['worker', 'stream_activity_rust.health_errors', 1, 'error', ''],
        ['worker', 'stream_activity_rust.last_success_age_ms', 77, 'ok', ''],
    ]);
});

test('stream strict schema rejects malformed, private, foreign and oversized frames atomically', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); });
    const health = { event: 'health', success: true, hasPending: true };
    const batch = { event: 'batch', events: 1, durationMs: 2, success: true };
    for (const field of ['oldestPendingAgeMs', 'checkpointSeq', 'activeBatchEvents', 'lastSuccessAgeMs']) {
        for (const value of [-1, '1', true, null, {}, [], 1e15 + 1]) feed(streamFrame({ ...health, [field]: value }));
        feed(`stream_activity:{"event":"health","success":true,"hasPending":true,"${field}":1e309}\n`);
    }
    for (const field of ['checkpointSeq', 'activeBatchEvents']) feed(streamFrame({ ...health, [field]: .5 }));
    for (const row of [{ event: 'health', success: true }, { ...health, hasPending: null }, { ...health, hasPending: 1 },
        { ...health, success: 'true' }, { ...health, hasPending: false, oldestPendingAgeMs: 0 }, { event: 'health' }]) feed(streamFrame(row));
    for (const [key, value] of [['hasPending', false], ['oldestPendingAgeMs', 0], ['checkpointSeq', 0], ['activeBatchEvents', 0]]) {
        feed(streamFrame({ event: 'health', success: false, [String(key)]: value }));
        feed(streamFrame({ event: 'health', success: false, [String(key)]: null }));
    }
    for (const row of [batch, health]) for (const field of ['channelID', 'query', 'name', 'dueChannels', 'phases']) {
        feed(streamFrame({ ...row, [field]: 'private' }));
    }
    feed(raidFrame({ ...health, dueChannels: 9 })); feed(baselineFrame(health));
    feed('stream_activity:{invalid}\nstream_activity:null\nstream_activity:[]\nprivate output\n');
    feed(`stream_activity:${' '.repeat(1024)}${JSON.stringify(health)}\n`);
    assert.deepEqual(samples, []);
    feed(streamFrame({ ...health, checkpointSeq: 1e15, activeBatchEvents: 1e15, oldestPendingAgeMs: 1e15, lastSuccessAgeMs: 1e15 }));
    assert.equal(samples.length, 6, 'valid bounded frame recovers after oversized input');
});

test('stream mixed health probes aggregate into analytics-valid private-free envelopes without lifecycle errors', async () => {
    telemetryTesting.reset(); telemetryTesting.enable();
    try {
        const feed = nativeProgressParser(observe);
        feed(streamFrame({ event: 'health', success: true, hasPending: true, oldestPendingAgeMs: 90,
            checkpointSeq: 2, activeBatchEvents: 4 }));
        feed(streamFrame({ event: 'health', success: false, lastSuccessAgeMs: 100 }));
        const { metrics, spans, logs } = telemetryTesting.snapshot();
        assert.deepEqual(spans, []); assert.deepEqual(logs, []);
        assert(metrics.every(row => row.channel === '' && row.name.startsWith('stream_activity_rust.')));
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.count, 2);
        assert.equal(metrics.find(row => row.name.endsWith('.health_query'))?.sum, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.count, 1);
        assert.equal(metrics.find(row => row.name.endsWith('.health_errors'))?.outcome, 'error');
        assert.equal(metrics.find(row => row.name.endsWith('.pending_work'))?.count, 1, 'failed probe never fabricates an empty backlog');
        assert.equal(metrics.find(row => row.name.endsWith('.last_success_age_ms'))?.sum, 100);
        assert(!metrics.some(row => row.kind === 'lifecycle' || /\.(errors|restarts)$/.test(row.name)));
        const source = await readFile(new URL('../../../../dima-analytics/src/store.mjs', import.meta.url), 'utf8');
        assert(source.startsWith("import pg from 'pg';\n"));
        const moduleUrl = 'data:text/javascript,' + encodeURIComponent(source.replace("import pg from 'pg';", 'const pg = {};'));
        const { validateBatch } = await import(moduleUrl);
        assert.doesNotThrow(() => validateBatch({ version: 1, id: '01234567-89ab-cdef-0123-456789abcdef',
            service: 'cron', instance: 'fixture', metrics, spans, logs }));
    } finally { telemetryTesting.reset(); telemetryTesting.stop(); }
});

const rouletteFrame = (row: Record<string, unknown>): string => `roulette_completion:${JSON.stringify(row)}\n`;

test('roulette validates batch-only processed-channel frames and recovers after malformed output', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'roulette-completion');
    const batch = { event: 'batch', events: 100, durationMs: 40000, success: true };
    for (const events of [-1, 101, .5, '1', null]) feed(rouletteFrame({ ...batch, events }));
    for (const durationMs of [-1, 300001, '1', null]) feed(rouletteFrame({ ...batch, durationMs }));
    feed(rouletteFrame({ ...batch, success: false }));
    feed(rouletteFrame({ ...batch, success: 'true' }));
    for (const extra of [{ phases: { queueMs: 1 } }, { phases: { claimMs: 1 } }, { channelId: 'private' },
        { query: 'private' }, { dueChannels: 1 }, { hasPending: false }]) feed(rouletteFrame({ ...batch, ...extra }));
    feed(rouletteFrame({ event: 'health', success: true, dueChannels: 1 }));
    feed(rouletteFrame({ event: 'health', success: false }));
    feed('roulette_completion:{"event":"batch","events":1,"durationMs":1e309,"success":true}\n');
    feed('roulette_completion:{invalid}\nroulette_completion:null\nroulette_completion:[]\nprivate output secret\n');
    feed(`roulette_completion:${' '.repeat(1100)}{}\n`);
    for (const prefix of ['stream_activity:', 'raid_analytics:', 'follow_defense_baseline:']) {
        feed(`${prefix}${JSON.stringify(batch)}\n`);
    }
    assert.deepEqual(samples, []);
    const valid = rouletteFrame(batch);
    feed(Buffer.from(valid.slice(0, 17))); assert.deepEqual(samples, []);
    feed(Buffer.from(valid.slice(17)));
    feed(rouletteFrame({ ...batch, events: 0, durationMs: 0 }));
    feed(rouletteFrame({ ...batch, events: 0, durationMs: 300000, success: false }));
    feed(rouletteFrame({ ...batch, events: 1, durationMs: .5 }));
    assert.deepEqual(samples, [
        ['worker', 'roulette_completion_rust.batch_channels', 100, 'ok'],
        ['queue_run', 'roulette_completion_rust.project_batch', 40000, 'ok'],
        ['worker', 'roulette_completion_rust.batch_channels', 0, 'idle'],
        ['queue_run', 'roulette_completion_rust.project_batch', 0, 'idle'],
        ['worker', 'roulette_completion_rust.batch_channels', 0, 'error'],
        ['queue_run', 'roulette_completion_rust.project_batch', 300000, 'error'],
        ['worker', 'roulette_completion_rust.batch_channels', 1, 'ok'],
        ['queue_run', 'roulette_completion_rust.project_batch', .5, 'ok'],
    ]);
});

test('roulette frames cannot enter other native parsers or produce phase/health metrics', () => {
    const samples: unknown[][] = [];
    for (const worker of ['stream-activity', 'raid-analytics', 'follow-defense-baseline'] as const) {
        const feed = nativeProgressParser((...args) => { samples.push(args); }, worker);
        feed(rouletteFrame({ event: 'batch', events: 1, durationMs: 2, success: true }));
        feed(rouletteFrame({ event: 'health', success: true }));
    }
    assert.deepEqual(samples, []);
    telemetryTesting.reset(); telemetryTesting.enable();
    try {
        const feed = nativeProgressParser(observe, 'roulette-completion');
        feed(rouletteFrame({ event: 'batch', events: 3, durationMs: 2, success: true }));
        const { metrics, spans, logs } = telemetryTesting.snapshot();
        assert.deepEqual(spans, []); assert.deepEqual(logs, []);
        assert.equal(metrics.length, 2);
        assert(metrics.every(row => row.channel === '' && row.name.startsWith('roulette_completion_rust.')));
        assert.equal(metrics.find(row => row.name.endsWith('.batch_channels'))?.sum, 3);
    } finally { telemetryTesting.reset(); telemetryTesting.stop(); }
});

test('roulette sampler emits only roulette runtime metrics', async () => {
    let reads = 0;
    const samples: unknown[][] = [];
    const stop = startNativeWorkerMetrics(42, {
        read: async () => snapshot(BigInt(++reads * 100)), ticks: async () => 100,
        now: () => reads * 1000, intervalMs: 2, observe: (...args) => { samples.push(args); },
    }, 'roulette-completion');
    await delay(15); stop();
    assert(samples.some(row => row[1] === 'roulette_completion_rust.rss_bytes'));
    assert(samples.some(row => row[1] === 'roulette_completion_rust.cpu_cores'));
    assert(samples.every(row => String(row[1]).startsWith('roulette_completion_rust.')));
});

const receiptsFrame = (row: Record<string, unknown>): string => `ai_usage_receipts:${JSON.stringify(row)}\n`;

test('receipts protocol is strictly batch-only with bounded counts and durations', () => {
    const samples: unknown[][] = [];
    const feed = nativeProgressParser((...args) => { samples.push(args); }, 'ai-usage-receipts');
    const batch = { event: 'batch', events: 1000, durationMs: 300000, success: true };
    for (const events of [-1, 1001, .5, '1', null, Number.MAX_SAFE_INTEGER]) feed(receiptsFrame({ ...batch, events }));
    for (const durationMs of [-1, 300001, '1', null, 1e309]) feed(receiptsFrame({ ...batch, durationMs }));
    feed(receiptsFrame({ ...batch, success: false }));
    feed(receiptsFrame({ ...batch, success: 'true' }));
    for (const extra of [{ phases: { queueMs: 1 } }, { channelID: 'private' }, { receipt: 'private' },
        { dueChannels: 1 }, { hasPending: false }, { inserted: 3 }]) feed(receiptsFrame({ ...batch, ...extra }));
    // No health frame exists for this protocol; it must stay silent like any other unknown event.
    feed(receiptsFrame({ event: 'health', success: true, dueChannels: 1 }));
    feed(receiptsFrame({ event: 'receipt', events: 1, durationMs: 1, success: true }));
    feed('ai_usage_receipts:{invalid}\nai_usage_receipts:null\nai_usage_receipts:[]\nprivate output secret\n');
    feed(`ai_usage_receipts:${' '.repeat(1100)}{}\n`);
    for (const prefix of ['stream_activity:', 'raid_analytics:', 'follow_defense_baseline:', 'roulette_completion:']) {
        feed(`${prefix}${JSON.stringify(batch)}\n`);
    }
    assert.deepEqual(samples, []);
    const valid = receiptsFrame(batch);
    feed(Buffer.from(valid.slice(0, 19))); assert.deepEqual(samples, []);
    feed(Buffer.from(valid.slice(19)));
    feed(receiptsFrame({ ...batch, events: 0, durationMs: 0 }));
    feed(receiptsFrame({ ...batch, events: 0, durationMs: 300000, success: false }));
    feed(receiptsFrame({ ...batch, events: 1, durationMs: .5 }));
    assert.deepEqual(samples, [
        ['worker', 'ai_usage_receipts_rust.batch_receipts', 1000, 'ok'],
        ['queue_run', 'ai_usage_receipts_rust.project_batch', 300000, 'ok'],
        ['worker', 'ai_usage_receipts_rust.batch_receipts', 0, 'idle'],
        ['queue_run', 'ai_usage_receipts_rust.project_batch', 0, 'idle'],
        ['worker', 'ai_usage_receipts_rust.batch_receipts', 0, 'error'],
        ['queue_run', 'ai_usage_receipts_rust.project_batch', 300000, 'error'],
        ['worker', 'ai_usage_receipts_rust.batch_receipts', 1, 'ok'],
        ['queue_run', 'ai_usage_receipts_rust.project_batch', .5, 'ok'],
    ]);
});

test('receipts frames stay inside their own parser and other workers ignore them', () => {
    const samples: unknown[][] = [];
    for (const worker of ['stream-activity', 'raid-analytics', 'follow-defense-baseline', 'roulette-completion'] as const) {
        const feed = nativeProgressParser((...args) => { samples.push(args); }, worker);
        feed(receiptsFrame({ event: 'batch', events: 1, durationMs: 2, success: true }));
        feed(receiptsFrame({ event: 'health', success: true }));
    }
    assert.deepEqual(samples, []);
    telemetryTesting.reset(); telemetryTesting.enable();
    try {
        const feed = nativeProgressParser(observe, 'ai-usage-receipts');
        feed(receiptsFrame({ event: 'batch', events: 7, durationMs: 12, success: true }));
        const { metrics, spans, logs } = telemetryTesting.snapshot();
        assert.deepEqual(spans, []); assert.deepEqual(logs, []);
        assert.equal(metrics.length, 2);
        assert(metrics.every(row => row.channel === '' && row.name.startsWith('ai_usage_receipts_rust.')));
        assert.equal(metrics.find(row => row.name.endsWith('.batch_receipts'))?.sum, 7);
        assert(!metrics.some(row => row.kind === 'lifecycle' || /\.(health_query|health_errors)$/.test(row.name)));
    } finally { telemetryTesting.reset(); telemetryTesting.stop(); }
});

test('receipts sampler emits only receipts runtime metrics', async () => {
    let reads = 0;
    const samples: unknown[][] = [];
    const stop = startNativeWorkerMetrics(42, {
        read: async () => snapshot(BigInt(++reads * 100)), ticks: async () => 100,
        now: () => reads * 1000, intervalMs: 2, observe: (...args) => { samples.push(args); },
    }, 'ai-usage-receipts');
    await delay(15); stop();
    assert(samples.some(row => row[1] === 'ai_usage_receipts_rust.rss_bytes'));
    assert(samples.some(row => row[1] === 'ai_usage_receipts_rust.cpu_cores'));
    assert(samples.every(row => String(row[1]).startsWith('ai_usage_receipts_rust.')));
});
