import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeCpuTracker, nativeProgressParser, parseNativeRss, parseNativeStat, startNativeWorkerMetrics, type NativeSnapshot } from './native_worker_metrics.js';

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
