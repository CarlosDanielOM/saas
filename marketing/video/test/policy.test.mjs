// What the recorder lets the player load, and that cancelling stops every ffmpeg it started.
import assert from 'node:assert/strict';
import test from 'node:test';
import {requestKind} from '../lib/record.mjs';
import {FFMPEG, run, stopChildren} from '../lib/tools.mjs';

test('only the site, its demo media and Google Fonts load', () => {
  const origin = 'http://127.0.0.1:4321';
  assert.equal(requestKind(`${origin}/main-ABC.js`, origin), 'site');
  assert.equal(requestKind(`${origin}/__demo/media/tts/x.mp3`, origin), 'media');
  assert.equal(requestKind('https://fonts.googleapis.com/css2?family=X', origin), 'font');
  assert.equal(requestKind('https://fonts.gstatic.com/s/x.woff2', origin), 'font');
  for (const blocked of ['https://api.domdimabot.com/users', 'https://tadd.domdimabot.com/e/', 'https://us.i.posthog.com/batch', 'wss://eventsub.wss.twitch.tv/ws',
    'https://domdimabot.com/mocks/dev/demo', 'http://fonts.googleapis.com/css2', 'http://127.0.0.1:9999/x']) {
    assert.equal(requestKind(blocked, origin), 'blocked', blocked);
  }
});

test('stopChildren kills running ffmpeg processes', async () => {
  // An endless ffmpeg (writes noise to /dev/null), like a mix interrupted by Ctrl-C.
  const pending = run(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=r=48000', '-f', 'null', '-'], {timeoutMs: 60000});
  await new Promise(r => setTimeout(r, 300));
  const started = Date.now();
  await stopChildren();
  await assert.rejects(pending, /exited null|exited 1|killed|SIGKILL|exited/);
  assert.ok(Date.now() - started < 3000, 'stopped promptly');
});
