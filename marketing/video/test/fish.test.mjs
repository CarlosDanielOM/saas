// Fish TTS engine against a local fake server: request shape, cache, free/paid gate, no fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {CACHE} from '../lib/paths.mjs';
import {resolve} from 'node:path';
import {prepareTts} from '../lib/tts.mjs';
import {FFMPEG, run} from '../lib/tools.mjs';

const dir = (mkdirSync(CACHE, {recursive: true}), mkdtempSync(resolve(CACHE, 'test-fish-')));
const requests = [];
let fail = false, mp3;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    requests.push({method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}')});
    if (fail) { res.writeHead(503, {'content-type': 'application/json', connection: 'close'}).end('{"message":"busy"}'); return; }
    res.writeHead(200, {'content-type': 'audio/mpeg', connection: 'close'}).end(mp3);
  });
});
test.before(async () => {
  const file = resolve(dir, 'tone.mp3');
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*330*t)':s=24000:d=1.25", '-c:a', 'libmp3lame', '-b:a', '64k', file]);
  mp3 = readFileSync(file);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
});
test.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, {recursive: true, force: true}); });

const VOICE = {engine: 'fish', reference_id: 'a'.repeat(32), model: 's2.1-pro-free', freeUntil: '2026-11-30', license: 'test', source: 'test'};
const voices = {defaults: {es: 'luz'}, voices: {luz: VOICE}};
const raw = {beats: [{do: 'tts', id: 't1', user: 'u', text: {en: 'hello there', es: '[happy] hola chat'}}]};
const env = () => ({FISH_AUDIO_API_KEY: 'test-key', FISH_API_BASE: `http://127.0.0.1:${server.address().port}`});

test('no voice chosen: the line stays a text card, no request', async () => {
  const {media, notes} = await prepareTts(raw, 'en', {voices, env: env(), clipsDir: dir});
  assert.deepEqual(media, {});
  assert.match(notes[0], /no voice chosen yet/);
  assert.equal(requests.length, 0);
});

test('free model: same request as the product, cached by text', async () => {
  const today = new Date('2026-11-08T12:00:00Z');
  const first = await prepareTts(raw, 'es', {voices, env: env(), clipsDir: dir, today});
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/tts');
  assert.equal(request.headers.authorization, 'Bearer test-key'); assert.equal(request.headers.model, 's2.1-pro-free');
  assert.deepEqual(request.body, {text: '[happy] [happy] hola chat', reference_id: VOICE.reference_id, format: 'mp3'});
  assert.ok(existsSync(first.media.t1.file));
  assert.ok(Math.abs(first.media.t1.durationMs - 1250) < 80, `clip length ${first.media.t1.durationMs}`);
  const again = await prepareTts(raw, 'es', {voices, env: env(), clipsDir: dir, today});
  assert.equal(requests.length, 1, 'second render uses the cached clip');
  assert.equal(again.media.t1.file, first.media.t1.file);
});

test('after the free period, synthesis needs --allow-paid-tts', async () => {
  const other = {beats: [{do: 'tts', id: 't2', user: 'u', text: {en: 'x', es: 'otra frase'}}]};
  await assert.rejects(prepareTts(other, 'es', {voices, env: env(), clipsDir: dir, today: new Date('2026-12-01')}), /costs money.*--allow-paid-tts/);
  const before = requests.length;
  await prepareTts(other, 'es', {voices, env: env(), clipsDir: dir, today: new Date('2026-12-01'), allowPaid: true});
  assert.equal(requests.length, before + 1);
});

test('only known free models skip the paid flag, whatever freeUntil a voice claims', async () => {
  const paid = {defaults: {es: 'pro'}, voices: {pro: {...VOICE, model: 's2.1-pro', freeUntil: '2099-01-01'}}};
  const line = {beats: [{do: 'tts', id: 't5', user: 'u', text: {en: 'x', es: 'modelo de pago'}}]};
  const before = requests.length;
  await assert.rejects(prepareTts(line, 'es', {voices: paid, env: env(), clipsDir: dir, today: new Date('2026-11-08')}), /s2\.1-pro costs money/);
  assert.equal(requests.length, before, 'no request without the flag');
  const {isFree} = await import('../lib/tts.mjs');
  assert.equal(isFree({model: 's2.1-pro-free'}, new Date('2026-11-30T23:00:00Z')), true);
  assert.equal(isFree({model: 's2.1-pro-free'}, new Date('2026-12-01T00:00:00Z')), false);
  assert.equal(isFree({model: 's2.1-pro-free', freeUntil: '2026-11-20'}, new Date('2026-11-25')), false, 'a voice can only shorten the free period');
});

test('a failure is reported, never retried with another model', async () => {
  fail = true;
  const before = requests.length;
  const broken = {beats: [{do: 'tts', id: 't3', user: 'u', text: {en: 'x', es: 'falla'}}]};
  await assert.rejects(prepareTts(broken, 'es', {voices, env: env(), clipsDir: dir, today: new Date('2026-11-08')}), /Fish TTS failed \(503\)/);
  assert.equal(requests.length, before + 1);
  fail = false;
});

test('a missing key is a clear error', async () => {
  const lone = {beats: [{do: 'tts', id: 't4', user: 'u', text: {en: 'x', es: 'sin llave'}}]};
  await assert.rejects(prepareTts(lone, 'es', {voices, env: {}, clipsDir: dir, today: new Date('2026-11-08')}), /FISH_AUDIO_API_KEY/);
});
