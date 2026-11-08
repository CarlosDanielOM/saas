// End to end against a built site bundle: the same frames twice (byte for byte), then a short MP4 with sound.
// Runs only inside the render scope + host lock (npm run demo:test).
//   DEMO_TEST_BUNDLE=<dist/dimasite/browser> (default: the live bundle). Skips if that bundle has no demo player yet.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CACHE, LIVE_BUNDLE, SCENES} from '../lib/paths.mjs';
import {busyBuilds, memAvailableGiB} from '../lib/guard.mjs';
import {inScope} from '../lib/scope.mjs';
import {serveBundle} from '../lib/server.mjs';
import {captureFrames, loadScene, openPlayer, warmFonts} from '../lib/record.mjs';
import {muxAudio, startEncoder} from '../lib/encode.mjs';
import {soundFile} from '../lib/sfx.mjs';
import {CAPTURE_ARGS, FFMPEG, chromium, probe, run} from '../lib/tools.mjs';

const bundle = process.env.DEMO_TEST_BUNDLE || LIVE_BUNDLE;
const hasPlayer = existsSync(resolve(bundle, 'index.csr.html')) && readdirSync(bundle).some(f => f.endsWith('.js') && readFileSync(resolve(bundle, f), 'utf8').includes('__dimaDemo'));
const busy = busyBuilds();
const skip = !inScope() ? 'run it with `npm run demo:test` (memory cap + host lock)' : !hasPlayer ? `no demo player in ${bundle}` : busy.length ? 'an Angular/site build is running' : memAvailableGiB() < 4 ? 'needs 4 GiB of free memory' : false;
const raw = JSON.parse(readFileSync(resolve(SCENES, 'first-message-mod.json'), 'utf8'));

/** How many pixels differ between two PNGs, and by how much at most (0-255). */
async function pixelDifference(a, b) {
  const decode = png => run(FFMPEG, ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {input: png}).then(r => r.stdout);
  const [x, y] = await Promise.all([decode(a), decode(b)]);
  if (x.length !== y.length) return {pixels: Infinity, max: 255};
  let pixels = 0, max = 0;
  for (let i = 0; i < x.length; i += 3) {
    const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]));
    if (d) { pixels++; max = Math.max(max, d); }
  }
  return {pixels, max};
}

test('frames are identical on two separate renders', {skip}, async () => {
  const server = await serveBundle(bundle);
  const browser = await chromium().launch({args: CAPTURE_ARGS});
  try {
    await warmFonts(browser, {baseUrl: server.url, raw, format: 'vertical', lang: 'es'});
    const runs = [], pngs = [[], []];
    for (let run = 0; run < 2; run++) {
      const player = await openPlayer(browser, {baseUrl: server.url, format: 'vertical', lang: 'es', scale: 1, seed: raw.seed});
      await loadScene(player, raw, {format: 'vertical', lang: 'es'});
      const hashes = [];
      // Spam message, highlight, ban, bot notice and the caption handoff.
      await captureFrames(player, {fps: 30, durationMs: 15000, from: 100, to: 190, onFrame: png => { hashes.push(createHash('sha256').update(png).digest('hex')); pngs[run].push(png); }});
      assert.deepEqual(player.blocked, [], 'nothing outside the site was requested');
      await player.close();
      runs.push(hashes);
    }
    assert.equal(runs[0].length, 90);
    // Every frame must match exactly, including the first one after the jump into the middle of the scene.
    const first = runs[0].findIndex((h, i) => h !== runs[1][i]);
    let how = '';
    if (first >= 0) {
      // Keep the two versions of the first differing frame for inspection.
      mkdirSync(CACHE, {recursive: true});
      for (const [run, name] of [[0, 'a'], [1, 'b']]) writeFileSync(resolve(CACHE, `test-differs-${name}.png`), pngs[run][first]);
      how = ` by ${JSON.stringify(await pixelDifference(pngs[0][first], pngs[1][first]))}`;
    }
    assert.equal(first, -1, `frame ${100 + first} differs${how} (both versions saved as video/.cache/test-differs-{a,b}.png)`);
    assert.ok(new Set(runs[0]).size > 20, 'the frames actually change');
  } finally { await browser.close(); await server.close(); }
});

test('a short render encodes to H.264 + AAC with BT.709 tags', {skip}, async () => {
  mkdirSync(CACHE, {recursive: true});
  const dir = mkdtempSync(resolve(CACHE, 'test-rec-'));
  const server = await serveBundle(bundle);
  const browser = await chromium().launch({args: CAPTURE_ARGS});
  try {
    const player = await openPlayer(browser, {baseUrl: server.url, format: 'landscape', lang: 'en', scale: 1, seed: raw.seed});
    const info = await loadScene(player, raw, {format: 'landscape', lang: 'en'});
    const silent = resolve(dir, 'v.mp4'), out = resolve(dir, 'out.mp4');
    const encoder = startEncoder({file: silent, fps: 30});
    await captureFrames(player, {fps: 30, durationMs: info.durationMs, to: 60, onFrame: png => encoder.write(png)});
    await encoder.end();
    await player.close();
    await muxAudio({video: silent, durationMs: 2000, out, cues: [{file: await soundFile('kit:pop'), at: 300, gain: 1, fadeIn: 0, fadeOut: 0, end: null}]});
    const {streams, format} = await probe(out);
    const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio');
    assert.deepEqual([v.codec_name, v.pix_fmt, v.width, v.height, v.r_frame_rate, v.color_space, v.color_primaries, v.color_transfer], ['h264', 'yuv420p', 960, 540, '30/1', 'bt709', 'bt709', 'bt709']);
    assert.equal(a.codec_name, 'aac');
    assert.ok(Math.abs(Number(format.duration) - 2) < 0.08, `duration ${format.duration}`);
  } finally { await browser.close(); await server.close(); rmSync(dir, {recursive: true, force: true}); }
});
