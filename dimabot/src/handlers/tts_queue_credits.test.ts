import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let creditStatus = 'exhausted';
let lookupFails = false;
let pending = true;
let rawText = '[happy] Hello';
const synthesis: Array<{ provider: string; text: string; voice: string }> = [];
const cache = {
  zPopMin: async () => {
    if (!pending) return null;
    pending = false;
    return { value: 'speech-test' };
  },
  get: async (key: string) => key.includes(':queue:data:')
    ? JSON.stringify({ channelID: 'test', speechID: 'speech-test', provider: 'fish',
      mode: 'clone', language: 'en', voice: 'fish-id', piperFallbackVoice: 'piper-en', text: rawText })
    : 'pending',
  set: async () => {},
  del: async () => {},
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/websocket.js', { namedExports: { getIO: () => null } });
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
  mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
    [`${provider}TtsService`]: { synthesize: async (request: { text: string; voice: string }) => {
      synthesis.push({ provider, text: request.text, voice: request.voice });
      return { error: true, message: 'test stops before playback' };
    } },
    ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-test' } : {}),
  } });
}
const { ttsQueueHandler } = await import('./tts_queue.handler.js');

test('queued Fish requests recheck credits and use Piper when exhausted or unavailable', async () => {
  for (const status of ['exhausted', 'unavailable', 'available']) {
    pending = true;
    creditStatus = status;
    await ttsQueueHandler.processNext('test');
    assert.deepEqual(synthesis.at(-1), status === 'available'
      ? { provider: 'fish', text: '[happy] Hello', voice: 'fish-id' }
      : { provider: 'piper', text: 'Hello', voice: 'piper-en' });
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
