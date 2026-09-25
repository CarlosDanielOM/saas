import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const html = process.env.TTS_OVERLAY_HTML
  ? readFileSync(process.env.TTS_OVERLAY_HTML, 'utf8')
  : await (await fetch('http://127.0.0.1:3000/speech/fixture')).text();
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script, 'speech overlay script is present');

if (!process.env.TTS_OVERLAY_HTML) {
  const { getTtsPlaybackTimeoutMs } = await import('/app/dist/utils/tts/tts_playback_timeout.util.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tts-playback-'));
  try {
    const mp3Path = path.join(directory, 'one-second.mp3');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1', '-y', mp3Path]);
    const mp3Timeout = await getTtsPlaybackTimeoutMs(mp3Path);
    assert.ok(mp3Timeout === 60_000, `MP3 timeout: ${mp3Timeout}`);

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
    assert.equal(await getTtsPlaybackTimeoutMs(wavPath), 60_000);
    assert.equal(await getTtsPlaybackTimeoutMs(path.join(directory, 'missing.mp3')), 60_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  execFileSync(process.execPath, [
    '--experimental-test-module-mocks', '--test-force-exit', '--test',
    '/app/dist/handlers/tts_queue_credits.test.js',
  ], { stdio: 'inherit', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } });
}
console.log('PASS: candidate overlay present');

// Exercise the actual runtime, routes and namespace using disposable databases
// and the fish-fixtures provider mock. No production credentials or data.
if (!process.env.TTS_OVERLAY_HTML) {
  const { createClient } = createRequire('/app/package.json')('redis');
  const redis = createClient({ url: 'redis://redis:6379' });
  await redis.connect();
  const channel = '999991';
  const namespace = `/speech/${channel}`;
  const messages = [];
  const ws = new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  const send = (event, payload) => ws.send(`42${namespace},${JSON.stringify([event, payload])}`);
  const wait = async (condition, message) => {
    const deadline = Date.now() + 15000;
    while (!await condition()) {
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
    ws.addEventListener('message', event => {
      const data = String(event.data);
      if (data === '2') ws.send('3');
      else if (data.startsWith('0')) ws.send(`40${namespace},{}`);
      else if (data.startsWith(`42${namespace},`)) messages.push(JSON.parse(data.slice(`42${namespace},`.length)));
    });
  try {
    await redis.hSet(`accounts:twitch:${channel}:data`, { id: channel, name: 'test', polar_sh_customer_id: 'test-customer', plan_tier: 'premium' });
    await redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({ version: 3, used: 0, limit: 10000, balance: 10000, available: true, status: 'available' }));
    await wait(() => redis.exists(`twitch:${channel}:tts:connected`), 'overlay connection');
    const request = async text => {
      const response = await fetch(`http://127.0.0.1:3000/speech/${channel}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'clone', cloneName: 'rias_gremory', text, language: 'en' }),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.data.speechID;
    };
    const first = await request('First complete sentence');
    const second = await request('Second complete sentence');
    await wait(() => messages.some(([event, data]) => event === 'speech' && data.speechID === first), 'first delivery');
    const audio = messages.find(([event, data]) => event === 'speech' && data.speechID === first)[1];
    const response = await fetch(`http://127.0.0.1:3000${new URL(audio.audioUrl, "http://127.0.0.1:3000").pathname}`);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
    send('speech-playback', { speechID: first, phase: 'loading', position: 0 });
    send('speech-playback', { speechID: first, phase: 'progress', position: 1 });
    send('speech-ended', { speechID: 'stale' });
    send('speech-ended', {});
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), first);
    assert.equal(messages.filter(([event]) => event === 'speech').length, 1);
    // A supplied foreign channel cannot redirect completion away from this namespace.
    send('speech-ended', { channelID: 'foreign', speechID: first, reason: 'ended' });
    send('speech-ended', { speechID: first, reason: 'ended' });
    await wait(() => messages.some(([event, data]) => event === 'speech' && data.speechID === second), 'second delivery');
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), second);
    send('speech-ended', { speechID: first });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await redis.get(`twitch:${channel}:tts:processing`), second);
    send('speech-ended', { speechID: second, reason: 'ended' });
    await wait(async () => !await redis.exists(`twitch:${channel}:tts:processing`), 'queue completion');
    assert.equal(await redis.zCard(`twitch:${channel}:tts:queue`), 0);
    console.log('PASS: runtime synthesis/audio route, ordered websocket delivery, namespace binding and duplicate/stale completion');
  } finally {
    ws.close();
    await redis.quit();
  }
}
