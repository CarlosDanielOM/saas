import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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
