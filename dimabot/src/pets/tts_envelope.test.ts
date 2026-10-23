import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmsEnvelope } from './tts_envelope.js';
test('40ms RMS uses x4 scaling, finite bounded values and at most 1500 samples', () => {
    const pcm = Buffer.alloc(8000 * 60 * 4);
    for (let i = 320; i < 640; i++) pcm.writeFloatLE(0.125, i * 4);
    for (let i = 640; i < 960; i++) pcm.writeFloatLE(2, i * 4);
    const envelope = rmsEnvelope(pcm);
    assert.equal(envelope.stepMs, 40); assert.equal(envelope.values.length, 1500);
    assert.deepEqual(envelope.values.slice(0, 4), [0, 0.5, 1, 0]);
    assert.throws(() => rmsEnvelope(Buffer.alloc(pcm.length + 4)));
    const invalid = Buffer.alloc(4); invalid.writeFloatLE(NaN); assert.throws(() => rmsEnvelope(invalid));
    assert.throws(() => rmsEnvelope(Buffer.alloc(0)));
});
