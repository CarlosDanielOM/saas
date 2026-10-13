import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saas-fish-backend-'));
const backends: string[] = [];
const texts: string[] = [];
let failedBackends = new Set<string>();
let emptyBackends = new Set<string>();
mock.module('fish-audio', { namedExports: {
  FishAudioClient: class {
    textToSpeech = {
      convert: async (request: { text: string }, backend: string) => {
        backends.push(backend);
        texts.push(request.text);
        if (failedBackends.has(backend)) {
          throw new Error(`${backend} unavailable`);
        }
        return new ReadableStream<Uint8Array>({
          start(controller) {
            if (!emptyBackends.has(backend)) controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        });
      },
    };
  },
} });
mock.module('./piper_tts.service.js', { namedExports: {
  PIPER_PUBLIC_SPEECH_DIR: outputDir,
  buildPublicPath: () => '/test/audio',
} });
process.env.FISH_AUDIO_API_KEY = 'test-only';
const { fishTtsService } = await import('./fish_tts.service.js');

test('Fish speech prefers drama-3 and falls back to s2.1-pro on failed or empty audio', async () => {
  try {
    const request = {
      channelID: 'channel', speechID: 'speech', mode: 'clone', provider: 'fish',
      text: '[happy] Hello <whisper>chat<whisper>', language: 'en', voice: 'voice-id', outputPath: '',
    } as const;

    let result = await fishTtsService.synthesize(request);
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['drama-3']);
    assert.deepEqual(texts, ['[happy] Hello <whisper>chat<whisper>']);
    assert.match(result.message, /\(drama-3\)/);
    assert.deepEqual(await fs.readFile(result.outputPath!), Buffer.from([1, 2, 3]));

    backends.length = 0;
    texts.length = 0;
    failedBackends = new Set(['drama-3']);
    result = await fishTtsService.synthesize({ ...request, speechID: 'fallback' });
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['drama-3', 's2.1-pro']);
    assert.deepEqual(texts, ['[happy] Hello <whisper>chat<whisper>', '[happy] [happy] Hello <whisper>chat<whisper>']);
    assert.match(result.message, /\(s2\.1-pro\)/);
    assert.deepEqual(await fs.readFile(result.outputPath!), Buffer.from([1, 2, 3]));

    backends.length = 0;
    texts.length = 0;
    failedBackends = new Set();
    emptyBackends = new Set(['drama-3']);
    result = await fishTtsService.synthesize({ ...request, speechID: 'empty-primary' });
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['drama-3', 's2.1-pro']);
    assert.match(result.message, /\(s2\.1-pro\)/);
    assert.deepEqual(await fs.readFile(result.outputPath!), Buffer.from([1, 2, 3]));

    backends.length = 0;
    texts.length = 0;
    emptyBackends = new Set();
    failedBackends = new Set(['drama-3', 's2.1-pro']);
    result = await fishTtsService.synthesize({ ...request, speechID: 'both-failed' });
    assert.equal(result.error, true);
    assert.deepEqual(backends, ['drama-3', 's2.1-pro']);
    assert.match(result.message, /all enabled backends: drama-3: drama-3 unavailable; s2\.1-pro: s2\.1-pro unavailable/);
    assert.equal(result.outputPath, undefined);
    await assert.rejects(fs.access(path.join(outputDir, 'channel', 'both-failed.mp3')), { code: 'ENOENT' });
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
