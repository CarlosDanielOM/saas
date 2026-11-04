import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { computeMouthCurves, sampleMouthCurves, MAX_MOUTH_BINS } from './mouth_curves.js';
import { pcmMouthCurves } from './tts_envelope.js';

async function fixture() {
    const wav = await readFile(new URL('../../src/pets/fixtures/mock-reply.wav', import.meta.url));
    let sampleRate = 0, channels = 0, data = Buffer.alloc(0);
    for (let offset = 12; offset + 8 <= wav.length;) {
        const name = wav.toString('ascii', offset, offset + 4), length = wav.readUInt32LE(offset + 4), start = offset + 8;
        if (name === 'fmt ') {
            assert.equal(wav.readUInt16LE(start), 1); assert.equal(wav.readUInt16LE(start + 14), 16);
            channels = wav.readUInt16LE(start + 2); sampleRate = wav.readUInt32LE(start + 4);
        } else if (name === 'data') data = wav.subarray(start, start + length);
        offset = start + length + length % 2;
    }
    assert.ok(data.length); assert.ok(channels); assert.ok(sampleRate);
    const pcm = Array.from({ length: channels }, (_value, channel) => Float32Array.from({ length: data.length / (2 * channels) }, (_unused, frame) => data.readInt16LE((frame * channels + channel) * 2) / 32768));
    const expected = JSON.parse(await readFile(new URL('../../src/pets/fixtures/mouth-curves-mock-reply.json', import.meta.url), 'utf8'));
    return { pcm, sampleRate, expected };
}
test('dima-mouth-v1 matches the desktop mock-reply fixture within 0.001', async () => {
    const { pcm, sampleRate, expected } = await fixture(), curves = computeMouthCurves(pcm, sampleRate);
    assert.equal(curves.binFrames, expected.binFrames); assert.equal(curves.sampleRate, expected.sampleRate);
    for (const key of ['open', 'smile'] as const) {
        assert.equal(curves[key].length, expected[key].length);
        let maxError = 0;
        curves[key].forEach((value, i) => { maxError = Math.max(maxError, Math.abs(value - expected[key][i])); assert.ok(Math.abs(value - expected[key][i]) <= .001, `${key}[${i}]=${value}, expected ${expected[key][i]}`); });
        console.log(`${key}: ${curves[key].length} bins, max absolute fixture error ${maxError}`);
    }
});
test('loudness preserves opposite-phase stereo while smile bands use the mono average', () => {
    const signal = Float32Array.from({ length: 8000 }, (_value, i) => .15 * Math.sin(2 * Math.PI * 1000 * i / 8000));
    const inverted = signal.map(value => -value), mono = computeMouthCurves([signal], 8000), stereo = computeMouthCurves([signal, inverted], 8000);
    assert.deepEqual(stereo.open, mono.open); assert.ok(stereo.open.some(value => value > .9));
    assert.ok(stereo.smile.every(value => value === .5));
    assert.deepEqual(computeMouthCurves([signal, signal], 8000), mono);
    const interleaved = Buffer.alloc(signal.length * 2 * 4);
    for (let i = 0; i < signal.length; i++) { interleaved.writeFloatLE(signal[i], i * 8); interleaved.writeFloatLE(inverted[i], i * 8 + 4); }
    assert.deepEqual(pcmMouthCurves(interleaved, 8000, 2), stereo);
});
test('native bins, partial final bin, silence, neutral tails and 1800-bin bound', () => {
    const silence = computeMouthCurves([new Float32Array(22050 * 60)], 22050);
    assert.equal(silence.open.length, MAX_MOUTH_BINS); assert.ok(silence.open.every(value => value === 0)); assert.ok(silence.smile.every(value => value === .5));
    const partial = computeMouthCurves([new Float32Array(736).fill(.1)], 22050);
    assert.equal(partial.open.length, 2); assert.deepEqual(partial.open, [1, 1]);
    assert.deepEqual(sampleMouthCurves(partial, 0), { value: 1, smile: partial.smile[0] });
    assert.deepEqual(sampleMouthCurves(partial, 1000 / 30), { value: 1, smile: partial.smile[1] });
    const boundary = { sampleRate: 22050, binFrames: 735, open: Array.from({ length: 22 }, (_value, i) => i / 22), smile: Array(22).fill(.5) };
    assert.equal(sampleMouthCurves(boundary, 700).value, boundary.open[21], 'exact millisecond bin boundary does not round to the previous bin');
    for (const position of [-1, NaN, Infinity, 100]) assert.deepEqual(sampleMouthCurves(partial, position), { value: 0, smile: .5 });
    for (const channels of [[], [new Float32Array(0)], [new Float32Array(22050 * 60 + 1)], [new Float32Array([NaN])], [new Float32Array(2), new Float32Array(3)]]) assert.throws(() => computeMouthCurves(channels, 22050));
    for (const rate of [0, NaN, 1, 22050.5, 192001]) assert.throws(() => computeMouthCurves([new Float32Array(1)], rate));
    assert.throws(() => pcmMouthCurves(Buffer.alloc(1), 22050, 1));
});
