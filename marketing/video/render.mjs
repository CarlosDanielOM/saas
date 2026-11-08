#!/usr/bin/env node
// Render a demo-video scene to MP4 from the real product UI (/mocks/dev/demo).
//
//   npm run demo -- <scene> [options]          (from marketing/; the `--` passes options to this script)
//
//   <scene>              name in video/scenes/ (first-message-mod) or a path to a .json file
//   --vertical           only 1080x1920 (TikTok/Reels/Shorts)      --landscape   only 1920x1080 (Twitter/YouTube)
//   --lang en|es|all     languages (default: the scene's langs)    --fps 30|60   (default: scene fps or 30)
//   --preview            quick look: half size, 15 fps             --sheet       also write a contact sheet PNG
//   --frames A-B         render only frames A..B (testing)          --validate    check the scene and stop
//   --look NAME          site, studio, paper, signal, broadcast or night (default: the scene's "look")
//   --bundle DIR         site bundle to render (default: the live one, dimasite/dist/dimasite/browser)
//   --base-url URL       render from another address (still refuses while an Angular/site build runs)
//   --allow-paid-tts     allow TTS models that cost money          --emit-schema write video/scene.schema.json
//
// Output: video/out/<scene>/<scene>.<format>.<lang>.mp4 (+ .jpg poster, .json details, .sheet.png).
// Runs inside a memory/CPU-capped systemd scope holding a host-wide lock (one render at a time across checkouts);
// refuses to start while an Angular/site build runs. Ctrl-C stops Chromium and every ffmpeg and removes partial files.
import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {busyBuilds, memAvailableGiB} from './lib/guard.mjs';
import {inScope, relaunch} from './lib/scope.mjs';
import {LIVE_BUNDLE, OUT, REPO, VIDEO} from './lib/paths.mjs';
import {checkScene, findScene, scenesFor} from './lib/scene.mjs';
import {soundFile} from './lib/sfx.mjs';
import {prepareTts} from './lib/tts.mjs';
import {bundleHash, checkBundle, serveBundle} from './lib/server.mjs';
import {openPlayer, loadScene, captureFrames, warmFonts} from './lib/record.mjs';
import {muxAudio, startEncoder, writeJpeg, writeSheet} from './lib/encode.mjs';
import {CAPTURE_ARGS, chromium, playwrightVersion, probe, stopChildren} from './lib/tools.mjs';
import {DEMO_FORMATS, DEMO_LANGS, DEMO_LOOKS, sceneJsonSchema} from '../../dimasite/src/app/features/demo-video/demo-scene.ts';

const SCRIPT = fileURLToPath(import.meta.url);
/** Set once Ctrl-C/SIGTERM starts the cleanup: errors after that are consequences, not news. */
let aborting = false;
const SCOPE = {memory: '4G', cpu: '400%'};

function parseArgs(argv) {
  const opts = {positional: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts.positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    const takesValue = ['lang', 'fps', 'frames', 'bundle', 'base-url', 'look'].includes(key);
    opts[key] = takesValue ? (inline ?? argv[++i]) : true;
  }
  // `npm run demo first-message-mod --vertical` (without `--`) reaches us as npm_config_* variables.
  for (const key of ['vertical', 'landscape', 'preview', 'sheet', 'validate', 'allow-paid-tts', 'lang', 'fps', 'frames', 'bundle', 'base-url', 'emit-schema', 'look']) {
    const env = process.env[`npm_config_${key.replace(/-/g, '_')}`];
    if (opts[key] === undefined && env !== undefined && env !== '' && env !== 'false') opts[key] = env === 'true' ? true : env;
  }
  return opts;
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts['emit-schema']) {
    const file = resolve(VIDEO, 'scene.schema.json');
    writeFileSync(file, JSON.stringify(sceneJsonSchema(), null, 2) + '\n');
    console.log(`wrote ${relative(REPO, file)}`);
    return;
  }
  const {file: sceneFile, raw} = findScene(opts.positional[0]);
  const errors = checkScene(raw);
  if (errors.length) fail(`${relative(REPO, sceneFile)} has problems:\n  - ${errors.join('\n  - ')}`);
  const formats = (raw.formats ?? Object.keys(DEMO_FORMATS)).filter(f => (opts.vertical || opts.landscape ? (opts.vertical && f === 'vertical') || (opts.landscape && f === 'landscape') : true));
  const langs = opts.lang && opts.lang !== 'all' ? [opts.lang] : raw.langs ?? DEMO_LANGS;
  if (langs.some(l => !DEMO_LANGS.includes(l))) fail('--lang must be en, es or all');
  if (!formats.length) fail(`this scene has no ${opts.vertical ? 'vertical' : 'landscape'} format`);
  if (opts.look !== undefined && !DEMO_LOOKS.includes(opts.look)) fail(`--look must be one of: ${DEMO_LOOKS.join(', ')}`);
  const preview = !!opts.preview;
  const fps = preview ? 15 : Number(opts.fps ?? raw.fps ?? 30);
  if (!(preview || [30, 60].includes(fps))) fail('--fps must be 30 or 60');
  const frameRange = opts.frames ? opts.frames.split('-').map(Number) : null;
  if (frameRange && (frameRange.length !== 2 || frameRange.some(n => !Number.isInteger(n) || n < 0) || frameRange[1] <= frameRange[0])) fail('--frames must look like 0-90');
  if (opts.validate) {
    for (const lang of langs) {
      const {scene} = scenesFor(raw, lang);
      console.log(`${lang}: ${(scene.durationMs / 1000).toFixed(1)} s (duels estimated at 20 s), ${scene.beats.length} beats`);
    }
    console.log('✔ scene is valid');
    return;
  }

  if (!inScope()) { process.exitCode = await relaunch(SCRIPT, process.argv.slice(2), SCOPE); return; }

  // Host safety (whatever the target: Chromium and ffmpeg run on this host either way)
  const busy = busyBuilds();
  if (busy.length) fail(`an Angular/site build is running; render after it finishes:\n  ${busy.join('\n  ')}`);
  const free = memAvailableGiB();
  if (free < 4) fail(`only ${free.toFixed(1)} GiB of memory available; need 4 GiB free`);

  // Cancelling (Ctrl-C) or a failure stops every child process and removes the variant being written.
  let browser = null, server = null;
  const partial = new Set();
  const cleanup = async () => {
    await stopChildren();
    // Files first: nothing below may stall or exit before half-written output is gone.
    for (const file of partial) rmSync(file, {force: true});
    partial.clear();
    await browser?.close().catch(() => {});
    await server?.close();
  };
  const abort = code => {
    if (aborting) return;
    aborting = true;
    console.error('\n✖ cancelled: stopping Chromium and ffmpeg, removing partial files');
    void cleanup().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => abort(130));
  process.on('SIGTERM', () => abort(143));
  process.on('SIGHUP', () => abort(129));

  // Sounds and voices first: a bad file or a missing key fails before any browser work.
  const ttsByLang = {};
  for (const lang of langs) {
    const {media, notes} = await prepareTts(raw, lang, {allowPaid: !!opts['allow-paid-tts']});
    ttsByLang[lang] = media;
    for (const note of notes) console.log(`  · ${note}`);
  }

  const bundle = opts.bundle ? resolve(opts.bundle) : LIVE_BUNDLE;
  let baseUrl = opts['base-url'], hashBefore = null;
  if (!baseUrl) {
    checkBundle(bundle);
    hashBefore = bundleHash(bundle);
    server = await serveBundle(bundle);
    baseUrl = server.url;
  }
  // Our own signal handlers clean up; Playwright's would close Chromium and exit before ffmpeg is stopped.
  browser = await chromium().launch({handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: CAPTURE_ARGS});

  const outDir = resolve(OUT, raw.id + (preview ? '/preview' : ''));
  mkdirSync(outDir, {recursive: true});
  const results = [];
  try {
    await warmFonts(browser, {baseUrl, raw, format: formats[0], lang: langs[0]});
    for (const format of formats) for (const lang of langs) {
      const name = `${raw.id}.${format}.${lang}${opts.look ? `.${opts.look}` : ''}${frameRange ? `.frames-${frameRange[0]}-${frameRange[1]}` : ''}`;
      const started = Date.now();
      process.stdout.write(`▶ ${name} `);
      const media = ttsByLang[lang];
      const player = await openPlayer(browser, {baseUrl, format, lang, scale: preview ? 1 : 2, seed: raw.seed ?? 1, media});
      let encoder;
      try {
        const info = await loadScene(player, raw, {format, lang, media, look: opts.look});
        const silent = resolve(outDir, `${name}.video.mp4`), final = resolve(outDir, `${name}.mp4`);
        const outputs = [silent, final, ...['jpg', 'sheet.png', 'json'].map(ext => resolve(outDir, `${name}.${ext}`))];
        for (const file of outputs) { rmSync(file, {force: true}); partial.add(file); }
        encoder = startEncoder({file: silent, fps});
        const total = Math.ceil((info.durationMs * fps) / 1000);
        const posterIndex = Math.min(total - 1, Math.round((info.posterMs * fps) / 1000));
        const sheetEvery = Math.max(1, Math.floor(total / 12));
        const sheet = [];
        let poster = null, count = 0;
        await captureFrames(player, {fps, durationMs: info.durationMs, from: frameRange?.[0] ?? 0, to: frameRange?.[1], onFrame: async (png, index) => {
          await encoder.write(png);
          if (index === posterIndex || (!poster && frameRange)) poster = png;
          if (opts.sheet && index % sheetEvery === 0 && sheet.length < 12) sheet.push(png);
          if (++count % fps === 0) process.stdout.write('.');
        }});
        await encoder.end();
        if (player.blocked.length) throw new Error(`the player tried to load something outside the site (API, analytics, websocket…): ${player.blocked.join(', ')}`);
        if (player.pageErrors.length) throw new Error(`page errors: ${player.pageErrors.join(' | ')}`);
        // Sound: mixed from cues; a scene without sound gets no audio track.
        // A partial render (--frames) is as long as the frames it captured, and keeps sounds that started earlier.
        const durationMs = frameRange ? Math.round((count * 1000) / fps) : info.durationMs;
        const offset = frameRange ? (frameRange[0] * 1000) / fps : 0;
        const cues = [];
        for (const cue of info.cues) {
          const file = cue.kind === 'tts' ? Object.values(media).find(m => m.src === cue.src)?.file : await soundFile(cue.src);
          if (!file) continue;
          const at = cue.at - offset, end = cue.end === null ? null : cue.end - offset;
          if (at >= durationMs || (end !== null && end <= 0)) continue;
          cues.push({...cue, file, at: Math.max(0, at), skip: Math.max(0, -at), end});
        }
        const mixed = cues.length ? await muxAudio({video: silent, cues, durationMs, out: final}) : 0;
        if (mixed) rmSync(silent); else renameSync(silent, final);
        if (poster) await writeJpeg(poster, resolve(outDir, `${name}.jpg`));
        if (sheet.length) await writeSheet(sheet, resolve(outDir, `${name}.sheet.png`));
        const probed = await probe(final);
        const video = probed.streams.find(s => s.codec_type === 'video'), audio = probed.streams.find(s => s.codec_type === 'audio');
        const size = DEMO_FORMATS[format], scale = preview ? 1 : 2;
        const problems = [];
        if (video?.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p') problems.push(`video is ${video?.codec_name}/${video?.pix_fmt}`);
        if (video?.width !== size.width * scale || video?.height !== size.height * scale) problems.push(`size ${video?.width}x${video?.height}`);
        if (video?.r_frame_rate !== `${fps}/1`) problems.push(`frame rate ${video?.r_frame_rate}`);
        if (video?.color_space !== 'bt709' || video?.color_primaries !== 'bt709' || video?.color_transfer !== 'bt709') problems.push('color tags are not bt709');
        if (Boolean(audio) !== mixed > 0) problems.push(mixed ? 'audio track missing' : 'unexpected audio track');
        if (problems.length) throw new Error(`output check failed: ${problems.join(', ')}`);
        writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify({
          scene: relative(REPO, sceneFile), format, lang, look: opts.look ?? raw.look ?? 'studio', fps, frames: count, durationMs, size: `${video.width}x${video.height}`,
          audio: cues.map(c => ({kind: c.kind, src: c.src, at: c.at})), bundle: server ? {dir: bundle, hash: hashBefore} : {baseUrl},
          playwright: playwrightVersion(), chromium: browser.version(), renderedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000)
        }, null, 2) + '\n');
        results.push(final);
        for (const file of outputs) partial.delete(file);
        console.log(` ${(durationMs / 1000).toFixed(1)} s video, ${count} frames${mixed ? `, ${mixed} sound${mixed > 1 ? 's' : ''}` : ', silent'}, took ${Math.round((Date.now() - started) / 1000)} s`);
      } catch (error) {
        encoder?.kill();
        throw error;
      } finally {
        await player.close();
      }
    }
  } finally {
    await cleanup();
  }
  if (hashBefore && bundleHash(bundle) !== hashBefore) fail('the site was redeployed while rendering, so frames may mix two versions; render again');
  console.log(`\n✔ ${results.length} video${results.length > 1 ? 's' : ''} in ${relative(process.cwd(), outDir) || '.'}/`);
  for (const file of results) console.log(`  ${file}`);
}

main().catch(error => {
  if (aborting) return; // the signal handler finishes the cleanup and exits
  fail(error.stack?.split('\n').slice(0, 3).join('\n') ?? String(error));
});
