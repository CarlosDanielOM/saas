import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const data = new Map<string, string>();
const queues = new Map<string, string[]>();
const events: { channel: string; event: string; payload: any }[] = [];
let refreshes = 0;
let synthesize: (input: any) => Promise<any> = async () => ({ error: false, outputPath: '/tmp/tts-controls.wav', publicPath: '/audio/test' });
const synthesized: string[] = [];
const cache = {
  eval: async (_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> => {
    const next = await cache.zPopMin(options.keys[0]);
    if (!next) return [];
    return [next.value, await cache.get(options.keys[2]) ?? '', await cache.get(options.keys[1]) ?? ''];
  },
  get: async (key: string) => data.get(key) ?? null,
  set: async (key: string, value: string) => { data.set(key, value); },
  del: async (key: string) => { data.delete(key); queues.delete(key); },
  zPopMin: async (key: string) => { const value = queues.get(key)?.shift(); return value ? { value } : null; },
  zCard: async (key: string) => queues.get(key)?.length ?? 0,
  zRange: async (key: string) => [...queues.get(key) ?? []],
  keys: async () => [],
  multi: () => {
    const commands: (() => void)[] = [];
    const transaction = {
      zRem(key: string, ids: string[]) { commands.push(() => queues.set(key, (queues.get(key) ?? []).filter(id => !ids.includes(id)))); return transaction; },
      del(key: string) { commands.push(() => { data.delete(key); }); return transaction; },
      async exec() { commands.forEach(command => command()); }
    };
    return transaction;
  }
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/websocket.js', { namedExports: { getIO: () => ({ of: (channel: string) => ({
  sockets: new Map([['overlay', { connected: true, data: { ttsReady: true }, conn: { close: () => { refreshes++; } } }]]),
  emit: (event: string, payload: any) => events.push({ channel, event, payload })
}) }) } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ plan_tier: 'free' }) } });
mock.module('../utils/billing.js', { namedExports: { isAiCreditsExhausted: async () => false, getAiCredits: async () => ({ status: 'available' }) } });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => {} } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: () => {} } });
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => 60000 } });
for (const provider of ['piper', 'fish', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: (input: any) => { synthesized.push(input.speechID); return synthesize(input); } },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-controls' } : {})
} });
const { ttsQueueHandler: handler } = await import('./tts_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
const studio: string[] = [];
registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {}, controlTts: async (_channel, action) => { studio.push(action); } });

function seed(channel: string, ...ids: string[]) {
  queues.set(`twitch:${channel}:tts:queue`, ids);
  for (const speechID of ids) data.set(`twitch:${channel}:tts:queue:data:${speechID}`, JSON.stringify({ channelID: channel, speechID, provider: 'piper', mode: 'speak', language: 'en', voice: 'test', text: speechID }));
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition timed out');
}
const dispatched = (id: string) => events.some(e => e.event === 'speech' && e.payload.speechID === id);

test('skip advances exactly once and late completions cannot finish the next item', async () => {
  seed('skip', 'skip-a', 'skip-b');
  await handler.processNext('skip');
  await handler.control('skip', 'skip');
  await until(() => dispatched('skip-b'));
  assert.ok(events.some(e => e.channel === '/speech/skip' && e.event === 'speech-reset'));
  await handler.handleSpeechEnded('skip', 'skip-a');
  assert.equal(data.get('twitch:skip:tts:processing'), 'skip-b');
  await handler.handleSpeechEnded('skip', 'skip-b');
});

test('clear stops active playback and removes waiting payloads, without affecting another channel', async () => {
  seed('clear', 'clear-a', 'clear-b', 'clear-c'); seed('other', 'other-a');
  await handler.processNext('clear');
  await handler.control('clear', 'clear');
  assert.deepEqual(queues.get('twitch:clear:tts:queue'), []);
  assert.ok(!data.has('twitch:clear:tts:queue:data:clear-b'));
  assert.ok(!data.has('twitch:clear:tts:queue:data:clear-c'));
  assert.deepEqual(queues.get('twitch:other:tts:queue'), ['other-a']);
  assert.ok(!dispatched('clear-b'));
  assert.ok(events.some(e => e.channel === '/speech/clear' && e.event === 'speech-reset'));
});

for (const action of ['skip', 'clear', 'refresh'] as const) test(`${action} during synthesis discards its result and retains a single producer`, async () => {
  let resolve!: (value: any) => void;
  const original = synthesize;
  synthesize = input => input.speechID === `${action}-slow` ? new Promise(done => { resolve = done; }) : original(input);
  seed(`synth-${action}`, `${action}-slow`, `${action}-waiting`);
  const processing = handler.processNext(`synth-${action}`);
  await until(() => !!resolve);
  await handler.control(`synth-${action}`, action);
  assert.ok(!synthesized.includes(`${action}-waiting`));
  resolve(await original({}));
  await processing;
  await until(() => action === 'clear' || dispatched(`${action}-waiting`));
  assert.ok(!dispatched(`${action}-slow`));
  assert.equal(synthesized.filter(id => id === `${action}-waiting`).length, action === 'clear' ? 0 : 1);
  if (action !== 'clear') await handler.handleSpeechEnded(`synth-${action}`, `${action}-waiting`);
  synthesize = original;
});

test('refresh resets speech sources and forwards Studio recovery; empty controls are safe', async () => {
  for (const action of ['skip', 'clear', 'refresh'] as const) await handler.control('empty', action);
  assert.ok(refreshes > 0);
  assert.deepEqual(studio.slice(-3), ['skip', 'clear', 'refresh']);
});

test('control during the Studio handoff never delivers stale audio after the reset', async () => {
  let release!: () => void;
  registerStudioBridge({ hasSource: () => false, trigger: async () => {},
    media: () => new Promise<void>(done => { release = done; }),
    controlTts: async () => {} });
  seed('handoff', 'handoff-a');
  const processing = handler.processNext('handoff');
  await until(() => !!release);
  const control = handler.control('handoff', 'clear');
  release();
  await Promise.all([processing, control]);
  assert.ok(!dispatched('handoff-a'));
  assert.ok(events.some(e => e.channel === '/speech/handoff' && e.event === 'speech-reset'));
  assert.ok(!data.has('twitch:handoff:tts:processing'));
});

test('read-only status distinguishes preparing from playing, counts waiting speech and never advances the queue', async () => {
  registerStudioBridge({ hasSource: () => false, media: async () => {}, trigger: async () => {},
    ttsStatus: async () => ({ connected: true, playing: false, queueLength: 2 }) });
  seed('status', 'status-a', 'status-b');
  const before = synthesized.length;
  const status = await handler.getStatus('status');
  assert.deepEqual(status, { connected: true, playing: false, preparing: false, queueLength: 4 });
  assert.equal(synthesized.length, before);
  assert.deepEqual(queues.get('twitch:status:tts:queue'), ['status-a', 'status-b']);
  let release!: (value: any) => void;
  const original = synthesize;
  synthesize = () => new Promise(done => { release = done; });
  const processing = handler.processNext('status');
  await until(() => !!release);
  assert.deepEqual(await handler.getStatus('status'), { connected: true, playing: false, preparing: true, queueLength: 3 });
  synthesize = original;
  release(await original({}));
  await processing;
  assert.deepEqual(await handler.getStatus('status'), { connected: true, playing: true, preparing: false, queueLength: 3 });
  await handler.control('status', 'clear');
});
