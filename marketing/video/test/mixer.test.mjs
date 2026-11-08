// The audio mix, measured: silence before a cue, fade-in/out like the overlay, cut at the alert's end, sums.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {CACHE} from '../lib/paths.mjs';
import {resolve} from 'node:path';
import {muxAudio} from '../lib/encode.mjs';
import {soundFile} from '../lib/sfx.mjs';
import {FFMPEG, probe, run} from '../lib/tools.mjs';

const dir = (mkdirSync(CACHE, {recursive: true}), mkdtempSync(resolve(CACHE, 'test-mix-')));
test.after(() => rmSync(dir, {recursive: true, force: true}));

async function pcm(file) {
  const {stdout} = await run(FFMPEG, ['-loglevel', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4);
}
const rms = (s, fromMs, toMs) => { let sum = 0, n = 0; for (let i = Math.round(fromMs * 48); i < Math.round(toMs * 48); i++) { sum += s[i] * s[i]; n++; } return Math.sqrt(sum / n); };

test('fades, cut and sum match the cue rules', async () => {
  const video = resolve(dir, 'v.mp4'), tone = resolve(dir, 'tone.wav'), out = resolve(dir, 'out.mp4');
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=1", '-ac', '2', tone]);
  // A: 500 ms in, fade-in 200, fade-out 300, cut at 1300 (0.8 s of a 1 s clip). B+C: two quiet copies at 2000 that add up.
  await muxAudio({video, durationMs: 3000, out, cues: [
    {file: tone, at: 500, gain: 1, fadeIn: 200, fadeOut: 300, end: 1300},
    {file: tone, at: 2000, gain: 0.3, fadeIn: 0, fadeOut: 0, end: null},
    {file: tone, at: 2000, gain: 0.3, fadeIn: 0, fadeOut: 0, end: null}
  ]});
  const info = await probe(out);
  const audio = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac'); assert.equal(Number(audio.sample_rate), 48000); assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.06, `duration ${info.format.duration}`);
  const s = await pcm(out), full = 0.5 / Math.SQRT2;
  assert.ok(rms(s, 50, 450) < 0.005, 'silent before the cue');
  const rising = rms(s, 560, 620) / full;
  assert.ok(rising > 0.25 && rising < 0.65, `fade-in ramp (expected ~0.46): ${rising}`);
  assert.ok(Math.abs(rms(s, 750, 950) / full - 1) < 0.08, 'full volume after the fade-in');
  assert.ok(rms(s, 1220, 1290) / full < 0.35, 'fading out before the cut');
  assert.ok(rms(s, 1320, 1950) < 0.005, 'cut when the alert ends');
  assert.ok(Math.abs(rms(s, 2100, 2900) / full - 0.6) < 0.06, `two cues add up (no normalization): ${rms(s, 2100, 2900) / full}`);
});

test('a partial render keeps a sound that started earlier, mid-fade', async () => {
  const video = resolve(dir, 'v2.mp4'), tone = resolve(dir, 'tone2.wav'), out = resolve(dir, 'out2.mp4');
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=2", '-ac', '2', tone]);
  // Started 300 ms before the range with a 400 ms fade-in: it begins at 75% and reaches full volume.
  const mixed = await muxAudio({video, durationMs: 1000, out, cues: [
    {file: tone, at: 0, skip: 300, gain: 1, fadeIn: 400, fadeOut: 0, end: null},
    {file: tone, at: 0, skip: 2500, gain: 1, fadeIn: 0, fadeOut: 0, end: null}
  ]});
  assert.equal(mixed, 1, 'a sound that already ended is dropped');
  const s = await pcm(out), full = 0.5 / Math.SQRT2;
  const head = rms(s, 25, 60) / full;
  assert.ok(head > 0.65 && head < 0.92, `starts mid-fade (~0.8): ${head}`);
  assert.ok(Math.abs(rms(s, 300, 900) / full - 1) < 0.06, 'then full volume');
  assert.equal(await muxAudio({video, durationMs: 1000, out, cues: [{file: tone, at: 1200, gain: 1, fadeIn: 0, fadeOut: 0, end: null}]}), 0, 'nothing inside the video: no audio added');
  // An excerpt that ends before the sound does: no early fade-out (the 500 ms fade belongs to the sound's real end).
  const long = resolve(dir, 'out3.mp4');
  await muxAudio({video, durationMs: 1000, out: long, cues: [{file: tone, at: 0, skip: 300, gain: 1, fadeIn: 0, fadeOut: 500, end: 1700}]});
  const t = await pcm(long);
  assert.ok(Math.abs(rms(t, 850, 950) / full - 1) < 0.06, `still full volume where the excerpt ends: ${rms(t, 850, 950) / full}`);
});

test('the sound kit is generated, bit-exact', async () => {
  const file = await soundFile('kit:chime');
  const again = await soundFile('kit:chime');
  assert.equal(file, again);
  const info = await probe(file);
  assert.equal(info.streams[0].codec_name, 'pcm_s16le');
  await assert.rejects(soundFile('kit:nope'), /unknown kit sound/);
});
