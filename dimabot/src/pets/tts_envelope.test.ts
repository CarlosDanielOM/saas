import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mouthEnvelopes, pcmMouthCurves, ttsEnvelope } from './tts_envelope.js';
import { computeMouthCurves, sampleMouthCurves } from './mouth_curves.js';
test('native follow preserves 253 fixture bins and smile while legacy sampling keeps its exact old shape', async () => {
    const fixture = JSON.parse(await readFile(new URL('../../src/pets/fixtures/mouth-curves-mock-reply.json', import.meta.url), 'utf8'));
    const curves = { sampleRate: fixture.sampleRate, binFrames: fixture.binFrames, open: fixture.open, smile: fixture.smile };
    const envelopes = mouthEnvelopes(curves, 185378 / fixture.sampleRate * 1000);
    assert.equal(envelopes.native.stepMs, 1000 * 735 / 22050); assert.equal(envelopes.native.values.length, 253);
    assert.deepEqual(envelopes.native.values, fixture.open); assert.deepEqual(envelopes.native.smile, fixture.smile);
    assert.equal(envelopes.legacy.stepMs, 40); assert.equal(envelopes.legacy.values.length, 211);
    assert.deepEqual(Object.keys(envelopes.legacy), ['stepMs', 'values']);
    envelopes.legacy.values.forEach((value, i) => assert.ok(Math.abs(value - sampleMouthCurves(curves, i * 40).value) <= .00005));
    assert.equal(envelopes.legacy, envelopes.legacy, 'legacy projection is cached');
});
test('long native and legacy envelopes stay bounded, round to four decimals and fit 32KiB', () => {
    const curves = computeMouthCurves([new Float32Array(22050 * 60).fill(.1)], 22050);
    curves.open.fill(.999999); curves.smile.fill(.987654321);
    const envelopes = mouthEnvelopes(curves, 60_000);
    assert.equal(envelopes.native.values.length, 1800); assert.equal(envelopes.native.smile!.length, 1800);
    assert.equal(envelopes.legacy.values.length, 1500); assert.ok(envelopes.legacy.values.length * envelopes.legacy.stepMs <= 60_000);
    assert.ok(envelopes.native.values.length * envelopes.native.stepMs <= 60_000 + envelopes.native.stepMs);
    assert.ok(envelopes.native.values.every(value => value === 1)); assert.ok(envelopes.native.smile!.every(value => value === .9877));
    for (const envelope of [envelopes.native, envelopes.legacy]) assert.ok(Buffer.byteLength(JSON.stringify({ v: 1, followId: 'x'.repeat(256), generation: Number.MAX_SAFE_INTEGER, envelope, positionMs: 60_000, serverTime: Number.MAX_SAFE_INTEGER })) < 32768);
    const partial = computeMouthCurves([new Float32Array(8000 * 60)], 8000), padded = mouthEnvelopes(partial, 60_000).native;
    assert.ok(padded.values.length * padded.stepMs > 60_000); assert.ok(padded.values.length * padded.stepMs <= 60_000 + padded.stepMs);
    for (const duration of [0, NaN, 60_001]) assert.throws(() => mouthEnvelopes(curves, duration));
    for (const pcm of [Buffer.alloc(0), Buffer.alloc(1)]) assert.throws(() => pcmMouthCurves(pcm, 22050, 1));
    const invalid = Buffer.alloc(4); invalid.writeFloatLE(NaN); assert.throws(() => pcmMouthCurves(invalid, 22050, 1));
});
const hasDecoder = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 }).status === 0 &&
    spawnSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 2000 }).status === 0;
test('native ffmpeg decoder retains fixture rate and matches both desktop curves', { skip: !hasDecoder ? 'ffmpeg/ffprobe unavailable on host; run in exact API candidate' : false }, async () => {
    const expected = JSON.parse(await readFile(new URL('../../src/pets/fixtures/mouth-curves-mock-reply.json', import.meta.url), 'utf8'));
    const envelopes = await ttsEnvelope(fileURLToPath(new URL('../../src/pets/fixtures/mock-reply.wav', import.meta.url)));
    assert.equal(envelopes.native.stepMs, 1000 * expected.binFrames / expected.sampleRate);
    for (const [key, values] of [['open', envelopes.native.values], ['smile', envelopes.native.smile!]] as const) {
        assert.equal(values.length, expected[key].length);
        values.forEach((value, i) => assert.ok(Math.abs(value - expected[key][i]) <= .001, `${key}[${i}] decoder mismatch`));
    }
    assert.equal(envelopes.legacy.stepMs, 40); assert.equal(envelopes.legacy.values.length, 211); assert.equal('smile' in envelopes.legacy, false);
});
