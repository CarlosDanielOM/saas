/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import reference from './fixtures/mouth-curves-mock-reply.json';
import fixtureWav from './fixtures/mock-reply.wav?url&inline';
import { computeMouthCurves, sampleMouthCurves, MAX_MOUTH_BINS } from './mouth-curves';

/** The committed reference is ordinary signed 16-bit PCM WAV, not synthesized test input. */
function fixturePcm() {
  const bytes = Uint8Array.from(atob(fixtureWav.slice(fixtureWav.indexOf(',') + 1)), character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = 0, channels = 0, pcm: Int16Array | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true), start = at + 8;
    if (name === 'fmt ') {
      expect(view.getUint16(start, true)).toBe(1);
      expect(view.getUint16(start + 14, true)).toBe(16);
      channels = view.getUint16(start + 2, true); rate = view.getUint32(start + 4, true);
    }
    if (name === 'data') pcm = Int16Array.from({ length: size / 2 }, (_, i) => view.getInt16(start + i * 2, true));
    at = start + size + (size % 2);
  }
  if (!pcm || !channels || !rate) throw new Error('invalid_fixture');
  const samples = pcm;
  return { rate, channels: Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: samples.length / channels }, (_, frame) => samples[frame * channels + channel] / 32768)) };
}

describe('dima-mouth-v1 browser PCM curves', () => {
  it('matches both committed reference curves within absolute 0.001', () => {
    const pcm = fixturePcm(), curves = computeMouthCurves(pcm.channels, pcm.rate);
    expect(curves.sampleRate).toBe(reference.sampleRate); expect(curves.binFrames).toBe(reference.binFrames);
    for (const field of ['open', 'smile'] as const) {
      expect(curves[field]).toHaveLength(reference[field].length);
      const error = Math.max(...curves[field].map((value, i) => Math.abs(value - reference[field][i])));
      expect(error, `${field} maximum absolute error`).toBeLessThanOrEqual(.001);
      expect(curves[field].every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    }
  });

  it('samples native bins and returns neutral outside the curves', () => {
    const curves = computeMouthCurves([new Float32Array(1601).fill(.1)], 8000);
    const bin = curves.binFrames / curves.sampleRate * 1000;
    expect(sampleMouthCurves(curves, bin * 2.1)).toEqual({ value: curves.open[2], smile: curves.smile[2] });
    const boundary = { sampleRate: 22050, binFrames: 735, open: Array.from({ length: 22 }, (_, i) => i / 22), smile: Array(22).fill(.5) };
    expect(sampleMouthCurves(boundary, 700).value).toBe(boundary.open[21]);
    for (const position of [-1, NaN, Infinity, curves.open.length * bin + 1]) expect(sampleMouthCurves(curves, position)).toEqual({ value: 0, smile: .5 });
  });

  it('keeps opposite-phase stereo loudness while filtering the averaged mono signal', () => {
    const left = Float32Array.from({ length: 1600 }, (_, i) => .3 * Math.sin(2 * Math.PI * 900 * i / 8000));
    const right = Float32Array.from(left, sample => -sample);
    const mono = computeMouthCurves([left], 8000), stereo = computeMouthCurves([left, right], 8000);
    stereo.open.forEach((value, i) => expect(value).toBeCloseTo(mono.open[i], 12));
    expect(stereo.open.some(value => value > .5)).toBe(true);
    expect(stereo.smile.every(value => value === .5)).toBe(true);
  });

  it('bounds silent and invalid inputs to the existing maximum clip duration', () => {
    const silent = computeMouthCurves([new Float32Array(8000 * 60)], 8000);
    expect(silent.open.length).toBeLessThanOrEqual(MAX_MOUTH_BINS);
    expect(silent.open.every(value => value === 0)).toBe(true);
    expect(silent.smile.every(value => value === .5)).toBe(true);
    expect(() => computeMouthCurves([new Float32Array(8000 * 60 + 1)], 8000)).toThrow();
    expect(() => computeMouthCurves([new Float32Array([NaN])], 8000)).toThrow();
    expect(() => computeMouthCurves([new Float32Array(1), new Float32Array(2)], 8000)).toThrow();
    expect(() => computeMouthCurves([], 8000)).toThrow();
  });
});
