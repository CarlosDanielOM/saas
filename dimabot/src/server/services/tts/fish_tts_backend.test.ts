import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saas-fish-backend-'));
const originalFetch = globalThis.fetch;
const originalKeys = { openrouter: process.env.OPENROUTER_API_KEY, fish: process.env.FISH_AUDIO_API_KEY };
const attempts: { route: string; model: string; voice: string; text: string }[] = [];
let primaryFailure = '';
let fallbackFails = false;
let streamCancelled = false;
const audio = Buffer.from([1, 2, 3]);

mock.module('fish-audio', { namedExports: {
  FishAudioClient: class {
    constructor(options: { apiKey: string }) { assert.equal(options.apiKey, 'fish-test-only'); }
    textToSpeech = {
      convert: async (request: { text: string; reference_id: string; format: string }, backend: string,
        options: { abortSignal: AbortSignal; timeoutInSeconds: number }) => {
        attempts.push({ route: 'fish', model: backend, voice: request.reference_id, text: request.text });
        assert.equal(backend, 's2.1-pro', 'direct Fish must only use the retained fallback');
        assert.equal(request.format, 'mp3');
        assert.ok(options.abortSignal);
        assert.equal(options.timeoutInSeconds, 20);
        if (fallbackFails) throw new Error('s2.1-pro unavailable');
        return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(audio); controller.close(); } });
      },
    };
  },
} });
mock.module('./piper_tts.service.js', { namedExports: {
  PIPER_PUBLIC_SPEECH_DIR: outputDir, buildPublicPath: () => '/test/audio',
} });
const { fishTtsService, FISH_OPENROUTER_MODEL } = await import('./fish_tts.service.js');
const request = {
  channelID: 'channel', speechID: 'speech', mode: 'clone', provider: 'fish',
  text: '[happy] Hello <whisper>chat<whisper>', language: 'en', voice: 'b'.repeat(32), outputPath: '',
} as const;

beforeEach(() => {
  attempts.length = 0;
  primaryFailure = '';
  fallbackFails = false;
  streamCancelled = false;
  process.env.OPENROUTER_API_KEY = 'openrouter-test-only';
  process.env.FISH_AUDIO_API_KEY = 'fish-test-only';
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(options?.method, 'POST');
    assert.deepEqual(options?.headers, { Authorization: 'Bearer openrouter-test-only', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body, { model: 'fish-audio/drama-3', input: request.text, voice: request.voice, response_format: 'mp3' });
    assert.ok(options?.signal);
    attempts.push({ route: 'openrouter', model: body.model, voice: body.voice, text: body.input });
    if (primaryFailure === 'network') throw new Error('OpenRouter unreachable');
    if (primaryFailure === 'http') return new Response('{}', { status: 503 });
    if (primaryFailure === 'json') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    if (primaryFailure === 'headers-timeout') {
      return await new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
    }
    if (primaryFailure === 'broken-stream' || primaryFailure === 'body-timeout') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(audio);
          if (primaryFailure === 'broken-stream') controller.error(new Error('Broken audio stream'));
        },
        cancel() { streamCancelled = true; },
      });
      return new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    return new Response(primaryFailure === 'empty' ? new Uint8Array() : audio, { headers: { 'Content-Type': 'audio/mpeg' } });
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [['OPENROUTER_API_KEY', originalKeys.openrouter], ['FISH_AUDIO_API_KEY', originalKeys.fish]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  await fs.rm(outputDir, { recursive: true, force: true });
});

function expectedAttempts() {
  return [
    { route: 'openrouter', model: 'fish-audio/drama-3', voice: request.voice, text: request.text },
    { route: 'fish', model: 's2.1-pro', voice: request.voice, text: '[happy] [happy] Hello <whisper>chat<whisper>' },
  ];
}

test('Fish speech sends the existing voice ID and tags to OpenRouter Drama 3 by default', async () => {
  assert.equal(FISH_OPENROUTER_MODEL, 'fish-audio/drama-3');
  const result = await fishTtsService.synthesize(request);
  assert.equal(result.error, false);
  assert.deepEqual(attempts, expectedAttempts().slice(0, 1));
  assert.match(result.message, /\(fish-audio\/drama-3\)/);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.deepEqual(await fs.readFile(result.outputPath!), audio);
});

for (const failure of ['network', 'http', 'json', 'empty', 'broken-stream']) {
  test(`OpenRouter ${failure} failure uses direct Fish s2.1-pro with the same voice ID`, async () => {
    primaryFailure = failure;
    const result = await fishTtsService.synthesize({ ...request, speechID: failure });
    assert.equal(result.error, false);
    assert.deepEqual(attempts, expectedAttempts());
    assert.match(result.message, /\(s2\.1-pro\)/);
    assert.deepEqual(await fs.readFile(result.outputPath!), audio);
  });
}

for (const failure of ['headers-timeout', 'body-timeout']) {
  test(`the OpenRouter deadline covers ${failure} and proceeds to Fish`, async () => {
    primaryFailure = failure;
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      originalTimer(callback, delay === 20_000 ? 10 : delay, ...args)) as typeof setTimeout;
    try {
      const result = await fishTtsService.synthesize({ ...request, speechID: failure });
      assert.equal(result.error, false);
      assert.deepEqual(attempts, expectedAttempts());
      if (failure === 'body-timeout') assert.equal(streamCancelled, true);
    } finally { globalThis.setTimeout = originalTimer; }
  });
}

test('both providers failing return their errors and never write partial audio', async () => {
  primaryFailure = 'http';
  fallbackFails = true;
  const result = await fishTtsService.synthesize({ ...request, speechID: 'both-failed' });
  assert.equal(result.error, true);
  assert.deepEqual(attempts, expectedAttempts());
  assert.match(result.message, /fish-audio\/drama-3: OpenRouter Fish synthesis failed \(HTTP 503\); s2\.1-pro: s2\.1-pro unavailable/);
  assert.equal(result.outputPath, undefined);
  await assert.rejects(fs.access(path.join(outputDir, 'channel', 'both-failed.mp3')), { code: 'ENOENT' });
});

test('missing credentials skip that provider and permit the separately configured route', async () => {
  delete process.env.FISH_AUDIO_API_KEY;
  assert.equal((await fishTtsService.synthesize(request)).error, false);
  assert.deepEqual(attempts, expectedAttempts().slice(0, 1));
  attempts.length = 0;
  delete process.env.OPENROUTER_API_KEY;
  process.env.FISH_AUDIO_API_KEY = 'fish-test-only';
  assert.equal((await fishTtsService.synthesize(request)).error, false);
  assert.deepEqual(attempts, expectedAttempts().slice(1));
  attempts.length = 0;
  delete process.env.FISH_AUDIO_API_KEY;
  const result = await fishTtsService.synthesize(request);
  assert.equal(result.error, true);
  assert.match(result.message, /OpenRouter API key is not configured/);
  assert.match(result.message, /Fish Audio API key is not configured/);
  assert.deepEqual(attempts, []);
});
