import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saas-fish-backend-'));
const backends: string[] = [];
mock.module('fish-audio', { namedExports: {
  FishAudioClient: class {
    textToSpeech = {
      convert: async (_request: unknown, backend: string) => {
        backends.push(backend);
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

test('Fish speech uses s2.1-pro-free as its default backend', async () => {
  try {
    const result = await fishTtsService.synthesize({
      channelID: 'channel', speechID: 'speech', mode: 'clone', provider: 'fish',
      text: 'Hello chat', language: 'en', voice: 'voice-id', outputPath: '',
    });
    assert.equal(result.error, false);
    assert.deepEqual(backends, ['s2.1-pro-free']);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
