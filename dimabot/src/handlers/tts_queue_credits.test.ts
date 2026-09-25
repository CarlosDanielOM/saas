import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let creditStatus = 'exhausted';
let lookupFails = false;
let pending = true;
let rawText = '[happy] Hello';
let scriptedQueue: Array<{ value: string }> | null = null;
const synthesis: Array<{ provider: string; text: string; voice: string }> = [];
const synthesizeImpls: Record<string, (request: { text: string; voice: string }) => Promise<{ error: boolean; message: string }>> = {};
const emitted: Array<{ event: string; payload: { mode: string; audioUrl: string } }> = [];
let playbackAvailable = false;
const cache = {
  zPopMin: async () => {
    if (scriptedQueue) {
      return scriptedQueue.shift() ?? null;
    }
    if (!pending) return null;
    pending = false;
    return { value: 'speech-test' };
  },
  get: async (key: string): Promise<string | null> => key.includes(':queue:data:')
    ? JSON.stringify({ channelID: 'test', speechID: 'speech-test', provider: 'fish',
      mode: 'clone', language: 'en', voice: 'fish-id', piperFallbackVoice: 'piper-en', text: rawText })
    : 'pending',
  set: async () => {},
  del: async (_key?: string | string[]) => {},
  keys: async (): Promise<string[]> => [],
  zCard: async () => 0,
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/websocket.js', { namedExports: { getIO: () => playbackAvailable
  ? { of: () => ({ emit: (event: string, payload: { mode: string; audioUrl: string }) => emitted.push({ event, payload }) }) }
  : null } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {
  getTwitchAccountById: async () => {
    if (lookupFails) throw new Error('account unavailable');
    return { polar_sh_customer_id: 'customer', plan_tier: 'free' };
  },
} });
mock.module('../utils/billing.js', { namedExports: {
  isAiCreditsExhausted: async () => creditStatus === 'exhausted',
  getAiCredits: async () => ({ status: creditStatus }),
} });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => {} } });
for (const provider of ['fish', 'piper']) {
  synthesizeImpls[provider] = async (request: { text: string; voice: string }) => {
    synthesis.push({ provider, text: request.text, voice: request.voice });
    return { error: true, message: 'test stops before playback' };
  };
  mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
    [`${provider}TtsService`]: {
      synthesize: (request: { text: string; voice: string }) => synthesizeImpls[provider](request),
    },
    ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-test' } : {}),
  } });
}
const { ttsQueueHandler } = await import('./tts_queue.handler.js');

test('queued Fish requests recheck credits and use Piper when exhausted or unavailable', async () => {
  for (const status of ['exhausted', 'unavailable', 'available']) {
    pending = true;
    creditStatus = status;
    const before = synthesis.length;
    await ttsQueueHandler.processNext('test');
    assert.deepEqual(synthesis.slice(before), status === 'available'
      ? [
          { provider: 'fish', text: '[happy] Hello', voice: 'fish-id' },
          { provider: 'piper', text: 'Hello', voice: 'piper-en' },
        ]
      : [{ provider: 'piper', text: 'Hello', voice: 'piper-en' }]);
  }
  pending = true;
  lookupFails = true;
  await ttsQueueHandler.processNext('test');
  assert.equal(synthesis.at(-1)?.provider, 'piper');
  const count = synthesis.length;
  pending = true;
  rawText = '[happy]';
  await ttsQueueHandler.processNext('test');
  assert.equal(synthesis.length, count, 'empty fallback text is skipped');
});

test('a Fish synthesis that never finishes releases the channel and continues the queue', async () => {
  const originalFish = synthesizeImpls.fish;
  const originalTimeout = ttsQueueHandler.synthesisTimeoutMs;
  let started = 0;
  synthesizeImpls.fish = (request) => {
    started += 1;
    if (started === 1) {
      return new Promise(() => {});
    }
    synthesis.push({ provider: 'fish', text: request.text, voice: request.voice });
    return Promise.resolve({ error: true, message: 'second line' });
  };
  creditStatus = 'available';
  lookupFails = false;
  rawText = 'Hello again';
  scriptedQueue = [{ value: 'speech-a' }, { value: 'speech-b' }];
  ttsQueueHandler.synthesisTimeoutMs = 30;

  try {
    await ttsQueueHandler.processNext('hang-channel');
    for (let attempt = 0; attempt < 20 && started < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, 2);
    assert.equal(synthesis.at(-1)?.provider, 'piper');
    assert.equal(synthesis.at(-1)?.text, 'Hello again');
  } finally {
    synthesizeImpls.fish = originalFish;
    ttsQueueHandler.synthesisTimeoutMs = originalTimeout;
    scriptedQueue = null;
  }
});

test('a failed Fish request emits Piper audio for playback', async () => {
  const originalPiper = synthesizeImpls.piper;
  const originalGet = cache.get;
  const originalDel = cache.del;
  synthesizeImpls.piper = async (request) => {
    synthesis.push({ provider: 'piper', text: request.text, voice: request.voice });
    return { error: false, message: 'ok', outputPath: '/tmp/tts-test/audio.wav', publicPath: '/test/audio' };
  };
  creditStatus = 'available';
  lookupFails = false;
  rawText = '[happy] Hello';
  pending = true;
  playbackAvailable = true;
  const before = emitted.length;

  try {
    await ttsQueueHandler.processNext('playback-test');
    assert.deepEqual(emitted.slice(before), [{ event: 'speech', payload: {
      speechID: 'speech-test', audioUrl: '/test/audio', mimeType: 'audio/wav',
      mode: 'speak', text: 'Hello',
    } }]);
    const removed: string[] = [];
    cache.get = async (key: string) => key.endsWith(':tts:processing') ? null : originalGet(key);
    cache.del = async (key?: string | string[]) => {
      if (key) removed.push(...(Array.isArray(key) ? key : [key]));
    };
    await ttsQueueHandler.handleSpeechEnded('playback-test', 'speech-test');
    assert.ok(removed.includes('twitch:playback-test:tts:processing'), 'expired Redis key still releases active playback');
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
    await ttsQueueHandler.cleanupChannel('playback-test');
    playbackAvailable = false;
    synthesizeImpls.piper = originalPiper;
  }
});

test('a late overlay completion cannot release a newer speech', async () => {
  const originalGet = cache.get;
  const originalDel = cache.del;
  const removed: string[] = [];
  cache.get = async (key: string) => key.endsWith(':tts:processing') ? 'new-speech' : originalGet(key);
  cache.del = async (key?: string | string[]) => {
    if (key) removed.push(...(Array.isArray(key) ? key : [key]));
  };
  try {
    await ttsQueueHandler.handleSpeechEnded('late-channel', 'old-speech');
    assert.deepEqual(removed, []);
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
  }
});

test('startup drops processing locks left by a dead process', async () => {
  const removed: string[] = [];
  const originalKeys = cache.keys;
  const originalDel = cache.del;
  cache.keys = async () => ['twitch:stale:tts:processing'];
  cache.del = async (key?: string | string[]) => {
    if (key === undefined) return;
    removed.push(...(Array.isArray(key) ? key : [key]));
  };

  try {
    await ttsQueueHandler.releaseStaleProcessingLocks();
    assert.deepEqual(removed, ['twitch:stale:tts:processing']);
  } finally {
    cache.keys = originalKeys;
    cache.del = originalDel;
  }
});

test('overlay resume clears a processing key left by a dead process', async () => {
  let processing: string | null = 'old-speech';
  const originalGet = cache.get;
  const originalDel = cache.del;
  const originalZCard = cache.zCard;
  cache.get = async (key: string) => {
    if (key.endsWith(':tts:processing')) return processing;
    return originalGet(key);
  };
  cache.del = async (key?: string | string[]) => {
    const keys = key === undefined ? [] : Array.isArray(key) ? key : [key];
    if (keys.some((entry) => entry.endsWith(':tts:processing'))) {
      processing = null;
    }
  };
  cache.zCard = async () => 0;

  try {
    await ttsQueueHandler.resumeIfIdle('dead-channel');
    assert.equal(processing, null);
  } finally {
    cache.get = originalGet;
    cache.del = originalDel;
    cache.zCard = originalZCard;
  }
});
