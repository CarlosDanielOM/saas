import test from 'node:test';
import assert from 'node:assert/strict';
import { burstBackoff, idleBackoff, runWorker, HEALTH_INTERVAL_MS, type PassOutcome, type WorkerLoopDependencies, type WorkerOptions } from './worker_loop.js';

interface Recorded { batches: unknown[][]; health: unknown[][]; exits: number[]; logs: string[]; flushes: number }
function harness(args: string[] = []) {
    const seen: Recorded = { batches: [], health: [], exits: [], logs: [], flushes: 0 };
    let signal: (() => void) | undefined, clock = 0;
    const deps: Partial<WorkerLoopDependencies> = {
        args, exit: code => { seen.exits.push(code); }, onSignal: listener => { signal = listener; },
        now: () => clock, log: message => { seen.logs.push(message); }, flush: async () => { seen.flushes++; }, loadEnv: () => {},
        metrics: { batch: (...row: unknown[]) => { seen.batches.push(row); }, health: (...row: unknown[]) => { seen.health.push(row); } },
    };
    return { seen, deps, stop: () => signal!(), tick: (ms: number) => { clock += ms; } };
}
const options = (extra: Partial<WorkerOptions<PassOutcome>>): WorkerOptions<PassOutcome> => ({
    name: 'fixture', prefix: 'fixture.worker', batchMetric: 'batch_events', dryRun: 'dry', onFailure: 'exit',
    setup: async () => { throw new Error('unexpected setup'); }, ...extra,
});

test('idle polling backs off 1, 2, 4, 5 seconds and any work resumes at once', () => {
    const idle = idleBackoff();
    assert.deepEqual([false, false, false, false, false].map(idle), [1000, 2000, 4000, 5000, 5000]);
    assert.deepEqual([true, true, false, false].map(idle), [0, 0, 1000, 2000]);
});

test('burst backoff drains seven in a row, pauses on the eighth, and paces idle and failed passes', () => {
    const next = burstBackoff(8), work = { events: 1 }, idle = { events: 0 };
    assert.deepEqual(Array.from({ length: 17 }, () => next(work)), [0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 1000, 0]);
    assert.deepEqual([idle, idle, idle, idle, idle].map(next), [1000, 2000, 4000, 5000, 5000]);
    // Work resets idle polling; an idle or failed pass resets the burst count.
    assert.deepEqual([work, idle, null, { events: 1, failed: true }, idle, idle].map(next), [0, 1000, 1000, 1000, 1000, 2000]);
    assert.deepEqual(Array.from({ length: 8 }, () => next(work)), [0, 0, 0, 0, 0, 0, 0, 1000]);
});

test('dry run prints its description and never connects, signals or exits', async () => {
    const h = harness(['--dry-run']);
    await runWorker(options({}), h.deps);
    assert.deepEqual(h.seen, { batches: [], health: [], exits: [], logs: [], flushes: 0 });
});

test('ready passes run back to back, a signal lets the pass in flight finish, then flushes and exits 0', async () => {
    const h = harness(); const delays: (number | null)[] = []; let passes = 0, finished = 0;
    await runWorker(options({ setup: async () => ({
        pass: async () => {
            if (++passes === 3) { h.stop(); await new Promise(resolve => setTimeout(resolve, 5)); }
            finished++; h.tick(7);
            return { events: passes, phases: { claimMs: 1 } };
        },
        delayMs: outcome => { delays.push(outcome?.events ?? null); return 0; },
    }) }), h.deps);
    assert.equal(finished, 3);
    assert.deepEqual(h.seen.batches, [[1, 7, true, { claimMs: 1 }], [2, 7, true, { claimMs: 1 }], [3, 7, true, { claimMs: 1 }]]);
    assert.deepEqual(delays, [1, 2, 3]);
    assert.deepEqual([h.seen.exits, h.seen.flushes], [[0], 1]);
});

test('an idle wait is cut short by a signal instead of holding shutdown', async () => {
    const h = harness(); const started = Date.now();
    await runWorker(options({ setup: async () => ({
        pass: async () => ({ events: 0 }),
        delayMs: () => { setTimeout(h.stop, 5); return 60_000; },
    }) }), h.deps);
    assert(Date.now() - started < 2000);
    assert.deepEqual(h.seen.exits, [0]);
});

test('a failed pass exits 1 for the supervisor, or is logged and retried when the worker says so', async () => {
    const exits = harness();
    await runWorker(options({ setup: async () => ({ pass: async () => { throw new Error('storage'); }, delayMs: () => 0 }) }), exits.deps);
    assert.deepEqual(exits.seen.batches, [[0, 0, false, undefined]]);
    assert.deepEqual([exits.seen.exits, exits.seen.logs], [[1], ['pass failed']]);

    const retries = harness(); let passes = 0; const delays: unknown[] = [];
    await runWorker(options({ onFailure: 'retry', setup: async () => ({
        pass: async () => { if (++passes < 3) throw new Error('storage'); retries.stop(); return { events: 4 }; },
        delayMs: outcome => { delays.push(outcome); return 0; },
    }) }), retries.deps);
    assert.deepEqual(retries.seen.batches.map(row => row[2]), [false, false, true]);
    assert.deepEqual(delays, [null, null, { events: 4 }]);
    assert.deepEqual(retries.seen.exits, [0]);
});

test('once runs a single pass and reports its failure even for a retrying worker', async () => {
    const ok = harness(['--once']); let passes = 0;
    await runWorker(options({ setup: async () => ({ pass: async () => ({ events: ++passes }), delayMs: () => 0 }) }), ok.deps);
    assert.deepEqual([passes, ok.seen.exits], [1, [0]]);
    const failed = harness(['--once']);
    await runWorker(options({ onFailure: 'retry', setup: async () => ({ pass: async () => { throw new Error('x'); }, delayMs: () => 0 }) }), failed.deps);
    assert.deepEqual(failed.seen.exits, [1]);
});

test('a pass that reports its own partial failure is a failed batch but never ends a long-running worker', async () => {
    const h = harness(); let passes = 0; const waits: unknown[] = [];
    await runWorker(options({ setup: async stopping => ({
        pass: async () => { if (++passes === 2) h.stop(); return { events: 3, failed: passes === 1, phases: { queueMs: 2 }, stopped: stopping.aborted }; },
        delayMs: outcome => { waits.push(outcome?.failed ?? null); return 0; },
    }) }), h.deps);
    assert.deepEqual(h.seen.batches, [[3, 0, false, { queueMs: 2 }], [3, 0, true, { queueMs: 2 }]]);
    assert.deepEqual([waits, h.seen.exits], [[true, false], [0]]);
    const once = harness(['--once']);
    await runWorker(options({ setup: async () => ({ pass: async () => ({ events: 0, failed: true }), delayMs: () => 0 }) }), once.deps);
    assert.deepEqual(once.seen.exits, [1]);
});

test('startup failure exits 1 without running a pass', async () => {
    const h = harness();
    await runWorker(options({ setup: async () => { throw new Error('no database'); } }), h.deps);
    assert.deepEqual([h.seen.exits, h.seen.logs, h.seen.batches], [[1], ['startup failed'], []]);
});

test('health runs before the first pass, then every 30 s, with last-success age once work has succeeded', async () => {
    const h = harness(); let passes = 0;
    await runWorker(options({ setup: async () => ({
        pass: async () => { h.tick(HEALTH_INTERVAL_MS / 2); if (++passes === 4) h.stop(); return { events: passes === 1 ? 0 : 1 }; },
        delayMs: () => 0,
        health: async () => { if (passes === 2) throw new Error('probe'); return { backlog_channels: passes }; },
    }) }), h.deps);
    // Probes at start, after two passes (it throws: reported as unknown, never as an empty backlog), after four.
    assert.deepEqual(h.seen.health, [[{ backlog_channels: 0 }, undefined], [null, 0]]);
    assert.equal(h.seen.batches.length, 4);
});

test('a pass that outlives the watchdog reports a failed batch and exits 1', async () => {
    const h = harness();
    void runWorker(options({ watchdogMs: 20, setup: async () => ({ pass: () => new Promise<PassOutcome>(() => {}), delayMs: () => 0 }) }), h.deps);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(h.seen.batches, [[0, 0, false]]);
    assert.equal(h.seen.exits[0], 1);
    assert.match(h.seen.logs[0], /pass exceeded the 0\.02-second watchdog/);
});
