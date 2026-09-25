import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const html = process.env.TTS_OVERLAY_HTML
  ? readFileSync(process.env.TTS_OVERLAY_HTML, 'utf8')
  : await (await fetch('http://127.0.0.1:3000/speech/fixture')).text();
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, 'speech overlay script is present');

let now = 0;
let interval;
const sent = [];
let speechHandler;
let audio;
const socket = {
  on(event, handler) { if (event === 'speech') speechHandler = handler; },
  emit(event, payload) { sent.push({ event, payload }); },
};
const document = {
  createElement(tag) {
    assert.equal(tag, 'audio');
    const listeners = new Map();
    audio = {
      currentTime: 0,
      dataset: {},
      addEventListener(event, callback) { listeners.set(event, callback); },
      dispatch(event) { listeners.get(event)?.(); },
      play() { return new Promise(() => {}); },
      pause() {},
      remove() {},
    };
    return audio;
  },
  body: { appendChild() {} },
};
const context = {
  window: { location: { pathname: '/speech/fixture' } },
  document,
  io() { return socket; },
  Date: { now() { return now; } },
  setInterval(fn) { interval = fn; return 1; },
  clearInterval() { interval = undefined; },
};
vm.runInNewContext(script, context);

speechHandler({ speechID: 'hung', audioUrl: '/speech/audio/fixture/hung' });
assert.equal(sent.length, 0);
now = 5_000;
interval?.();
assert.equal(sent.length, 0, 'brief buffering does not skip a clip');
now = 9_000;
interval?.();
assert.deepEqual(sent.map(item => item.payload.speechID), ['hung'], 'stalled playback releases the queue');
audio.dispatch('error');
audio.dispatch('ended');
assert.equal(sent.length, 1, 'completion is sent only once');

speechHandler({ speechID: 'playing', audioUrl: '/speech/audio/fixture/playing' });
for (const [clock, position] of [[14_000, 1], [19_000, 2], [24_000, 3]]) {
  now = clock;
  audio.currentTime = position;
  interval?.();
  assert.equal(sent.length, 1, 'advancing playback stays active');
}
audio.dispatch('ended');
assert.deepEqual(sent.map(item => item.payload.speechID), ['hung', 'playing']);
if (!process.env.TTS_OVERLAY_HTML) {
  const { getTtsPlaybackTimeoutMs } = await import('/app/dist/utils/tts/tts_playback_timeout.util.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tts-playback-'));
  try {
    const mp3Path = path.join(directory, 'one-second.mp3');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1', '-y', mp3Path]);
    const mp3Timeout = await getTtsPlaybackTimeoutMs(mp3Path);
    assert.ok(mp3Timeout >= 9_000 && mp3Timeout < 11_000, `MP3 timeout: ${mp3Timeout}`);

    const wavPath = path.join(directory, 'one-second.wav');
    const wav = Buffer.alloc(44 + 32_000);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24);
    wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(32_000, 40);
    writeFileSync(wavPath, wav);
    assert.equal(await getTtsPlaybackTimeoutMs(wavPath), 9_000);
    assert.equal(await getTtsPlaybackTimeoutMs(path.join(directory, 'missing.mp3')), 30_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  execFileSync(process.execPath, [
    '--experimental-test-module-mocks', '--test-force-exit', '--test',
    '/app/dist/handlers/tts_queue_credits.test.js',
  ], { stdio: 'inherit', timeout: 30_000 });
}
console.log('PASS: stalled speech advances, progress stays active, and finish is idempotent');
