import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MouthAnalysisQueue, mouthCurvesInWorker, MAX_MOUTH_ANALYSES, MAX_QUEUED_MOUTH_ANALYSES } from './mouth_analysis.js';
import { pcmMouthCurves, ttsEnvelope } from './tts_envelope.js';

const pcm = (frames: number) => {
    const bytes = Buffer.alloc(frames * 4);
    new Float32Array(bytes.buffer, bytes.byteOffset, frames).fill(.1);
    return bytes;
};
test('worker matches sync curves and transfers owned PCM instead of cloning it', { timeout: 10_000 }, async () => {
    const bytes = pcm(22050), expected = pcmMouthCurves(bytes, 22050, 1);
    const result = await mouthCurvesInWorker(bytes, 22050, 1);
    assert.deepEqual(result, expected); assert.equal(bytes.byteLength, 0, 'owned PCM backing buffer was transferred');
    const sliced = Buffer.allocUnsafe(8).subarray(0, 4); sliced.writeFloatLE(.1);
    assert.deepEqual(await mouthCurvesInWorker(sliced, 22050, 1), pcmMouthCurves(sliced, 22050, 1));
});
test('main-loop timer continues while a full 60-second clip is filtered', { timeout: 10_000 }, async () => {
    const bytes = pcm(48000 * 60);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
        const result = await mouthCurvesInWorker(bytes, 48000, 1);
        assert.ok(ticks > 0, 'timer ran before analysis completed');
        assert.equal(result.open.length, 1800); assert.equal(result.smile.length, 1800);
        assert.ok(result.open.every(value => value >= 0 && value <= 1));
    } finally { clearInterval(timer); }
});
test('queue enforces two active analyses and eight waiting jobs, then drains cleanly after failure', async () => {
    const queue = new MouthAnalysisQueue();
    const release: (() => void)[] = [];
    let active = 0, peak = 0;
    const work = (id: number) => queue.run(async () => {
        active++; peak = Math.max(peak, active);
        try {
            await new Promise<void>(resolve => { release.push(resolve); });
            if (id === 0) throw new Error('injected_analysis_failure');
            return id;
        } finally { active--; }
    });
    const first = work(0); const firstRejected = assert.rejects(first, /injected_analysis_failure/);
    const rest = Array.from({ length: MAX_MOUTH_ANALYSES + MAX_QUEUED_MOUTH_ANALYSES - 1 }, (_value, i) => work(i + 1));
    assert.deepEqual(queue.status, { active: 2, queued: 8 });
    await assert.rejects(work(100), /mouth_analysis_busy/); assert.equal(peak, 2);
    for (let i = 0; i < 10; i++) {
        assert.ok(release.length, `job ${i} is active`); release.shift()!();
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    await firstRejected; assert.deepEqual(await Promise.all(rest), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(peak, 2); assert.deepEqual(queue.status, { active: 0, queued: 0 });
});
test('worker failures and deadlines retire their worker before the queue slot is reused', { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dima-mouth-worker-'));
    const queue = new MouthAnalysisQueue();
    try {
        const hang = path.join(directory, 'hang.mjs'); await writeFile(hang, 'setInterval(() => {}, 1000);');
        await assert.rejects(queue.run(() => mouthCurvesInWorker(pcm(10), 22050, 1, { workerUrl: pathToFileURL(hang), timeoutMs: 100 })), /mouth_analysis_timeout/);
        assert.deepEqual(queue.status, { active: 0, queued: 0 });
        const invalid = pcm(10); invalid.writeFloatLE(NaN);
        await assert.rejects(queue.run(() => mouthCurvesInWorker(invalid, 22050, 1)), /invalid_pcm/);
        assert.deepEqual(queue.status, { active: 0, queued: 0 });
        const missing = pathToFileURL(path.join(directory, 'missing.mjs'));
        await assert.rejects(queue.run(() => mouthCurvesInWorker(pcm(10), 22050, 1, { workerUrl: missing })), /Cannot find module|ERR_MODULE_NOT_FOUND/);
        assert.equal((await queue.run(() => mouthCurvesInWorker(pcm(10), 22050, 1))).open.length, 1);
        assert.deepEqual(queue.status, { active: 0, queued: 0 });
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('expired queued work is discarded without starting it', { timeout: 10_000 }, async () => {
    const queue = new MouthAnalysisQueue(20);
    const release: (() => void)[] = [];
    const held = Array.from({ length: 2 }, () => queue.run(() => new Promise<void>(resolve => { release.push(resolve); })));
    let ran = false;
    await assert.rejects(queue.run(async () => { ran = true; }), /mouth_analysis_queue_timeout/);
    assert.equal(ran, false); assert.deepEqual(queue.status, { active: 2, queued: 0 });
    release.forEach(done => done()); await Promise.all(held);
    assert.deepEqual(queue.status, { active: 0, queued: 0 });
});
test('cancelled queued clips never begin decoding and active workers are retired on abort', { timeout: 10_000 }, async () => {
    const queue = new MouthAnalysisQueue(), controller = new AbortController();
    const release: (() => void)[] = [];
    const held = Array.from({ length: 2 }, () => queue.run(() => new Promise<void>(resolve => { release.push(resolve); })));
    let ran = false;
    const waiting = queue.run(async () => { ran = true; }, controller.signal);
    controller.abort(); await assert.rejects(waiting, /mouth_analysis_cancelled/);
    assert.equal(ran, false); assert.deepEqual(queue.status, { active: 2, queued: 0 });
    release.forEach(done => done()); await Promise.all(held);
    const activeController = new AbortController();
    const active = queue.run(() => mouthCurvesInWorker(pcm(48000 * 60), 48000, 1, { signal: activeController.signal }), activeController.signal);
    activeController.abort(); await assert.rejects(active, /mouth_analysis_cancelled/);
    assert.deepEqual(queue.status, { active: 0, queued: 0 });
    const already = new AbortController(); already.abort();
    await assert.rejects(ttsEnvelope('/does-not-exist.wav', already.signal), /mouth_analysis_cancelled/, 'pre-cancelled clip never reaches stat/ffprobe');
});
