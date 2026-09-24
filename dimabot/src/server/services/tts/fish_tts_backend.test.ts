import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saas-fish-backend-'));
const backends: string[] = [];
let failedBackends = new Set<string>();
mock.module('fish-audio', { namedExports: {
  FishAudioClient: class {
    textToSpeech = {
      convert: async (_request: unknown, backend: string) => {
        backends.push(backend);
        if (failedBackends.has(backend)) {
          throw new Error(`${backend} unavailable`);
        }
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
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

test('Fish speech tries pro, then pro-free, before returning an error for Piper', async () => {
  try {
    const request = {
      channelID: 'channel', speechID: 'speech', mode: 'clone', provider: 'fish',
      text: 'Hello chat', language: 'en', voice: 'voice-id', outputPath: '',
    } as const;

    let result = await fishTtsService.synthesize(request);
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['s2.1-pro']);

    backends.length = 0;
    failedBackends = new Set(['s2.1-pro']);
    result = await fishTtsService.synthesize({ ...request, speechID: 'fallback' });
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['s2.1-pro', 's2.1-pro-free']);

    backends.length = 0;
    failedBackends.add('s2.1-pro-free');
    result = await fishTtsService.synthesize({ ...request, speechID: 'piper' });
    assert.equal(result.error, true);
    assert.deepEqual(backends, ['s2.1-pro', 's2.1-pro-free']);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
