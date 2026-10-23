import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const data = new Map<string, string>();
const queues = new Map<string, string[]>();
const events: { channel: string; event: string; payload: any }[] = [];
let refreshes = 0;
let synthesize: (input: any) => Promise<any> = async () => ({ error: false, outputPath: '/tmp/tts-controls.wav', publicPath: '/audio/test' });
const synthesized: string[] = [];
let usage = 0;
let readRoute: 'pet' | 'overlay' | null = 'pet';
let lastInput: any;
const readDeliveries: any[] = [], released: string[] = [];
const legacySockets = new Map<string, any>();
for (const id of ['legacy-a', 'legacy-b']) legacySockets.set(id, { id, connected: true, data: { ttsReady: true }, conn: { close: () => {} }, emit: (event: string, payload: any) => events.push({ channel: id, event, payload }) });
const cache = {
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
  sockets: legacySockets,
  emit: (event: string, payload: any) => events.push({ channel, event, payload })
}) }) } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ plan_tier: 'free' }) } });
mock.module('../utils/billing.js', { namedExports: { isAiCreditsExhausted: async () => false, getAiCredits: async () => ({ status: 'available' }) } });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => { usage++; } } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: () => {} } });
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => 60000 } });
for (const provider of ['piper', 'fish', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: (input: any) => { synthesized.push(input.speechID); return synthesize(input); } },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-controls' } : {})
} });
const { ttsQueueHandler: handler } = await import('./tts_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
const studio: string[] = [];
registerStudioBridge({ hasSource: () => true, media: async () => {}, trigger: async () => {}, controlTts: async (_channel, action) => { studio.push(action); }, readTts: async (_channel, input) => { readDeliveries.push(input); } });
const { registerReadTtsBridge } = await import('../pets/tts_bridge.js');
registerReadTtsBridge({ available: async () => true, prepare: async input => { lastInput = input; return readRoute ? { audio: readRoute, durationMs: 500 } : null; }, release: async (_channel, speech) => { released.push(speech); }, report: async () => {}, terminal: async () => {}, invalidated: async () => {} });

function seed(channel: string, ...ids: string[]) {
  queues.set(`twitch:${channel}:tts:queue`, ids);
  for (const speechID of ids) data.set(`twitch:${channel}:tts:queue:data:${speechID}`, JSON.stringify({ channelID: channel, speechID, provider: 'piper', mode: 'speak', language: 'en', voice: 'test', text: speechID }));
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition timed out');
}
const dispatched = (id: string) => events.some(e => e.event === 'speech' && e.payload.speechID === id);


const channels = ['read-pet', 'read-overlay', 'read-studio', 'read-default', 'read-skip', 'read-clear', 'read-refresh'];
after(async () => { for (const channel of channels) await handler.cleanupChannel(channel); registerReadTtsBridge(); });
test('normal queue synthesizes/debits once, pet route preserves captions without audio, waits for pet terminal', async () => {
  const before = usage; readRoute = 'pet'; seed('read-pet', 'pet-a', 'pet-b');
  await handler.processNext('read-pet');
  assert.equal(usage, before + 1); assert.equal(readDeliveries.at(-1).file, undefined);
  assert.equal(readDeliveries.at(-1).text, 'pet-a'); assert.equal(dispatched('pet-a'), false);
  assert.equal(data.get('twitch:read-pet:tts:processing'), 'pet-a');
  await handler.handleOverlayEnded('read-pet', 'pet-a', 'ended', 'legacy:legacy-a');
  assert.equal(data.get('twitch:read-pet:tts:processing'), 'pet-a', 'legacy completion cannot end pet-owned audio');
  const ended = lastInput.ended; await ended('pet:completed'); await until(() => synthesized.includes('pet-b'));
  assert.equal(usage, before + 2); await ended('pet:completed');
  assert.equal(data.get('twitch:read-pet:tts:processing'), 'pet-b');
  await handler.control('read-pet', 'clear');
});
test('same normal file fallback elects one ready legacy, Studio captions only, duplicate/wrong reports do not advance', async () => {
  const before = usage; readRoute = 'overlay'; seed('read-overlay', 'overlay-a'); await handler.processNext('read-overlay');
  assert.equal(usage, before + 1); assert.equal(readDeliveries.at(-1).legacy, true);
  assert.equal(readDeliveries.at(-1).file, lastInput.file);
  const audio = events.filter(event => event.event === 'speech' && event.payload.speechID === 'overlay-a');
  assert.equal(audio.length, 1); assert.equal(audio[0].channel, 'legacy-a');
  await handler.handleOverlayEnded('read-overlay', 'overlay-a', 'ended', 'legacy:legacy-b');
  assert.equal(data.get('twitch:read-overlay:tts:processing'), 'overlay-a');
  await handler.handleOverlayEnded('read-overlay', 'overlay-a', 'ended', 'legacy:legacy-a');
  assert.ok(events.some(event => event.channel === 'legacy-a' && event.event === 'speech-reset'));
});
test('Studio-only readTTS remains authoritative through actual owner report, while default-off timeout stays baseline', async () => {
  readRoute = 'overlay'; for (const socket of legacySockets.values()) socket.data.ttsReady = false;
  seed('read-studio', 'studio-a'); await handler.processNext('read-studio');
  assert.equal(data.get('twitch:read-studio:tts:processing'), 'studio-a'); assert.equal(readDeliveries.at(-1).legacy, false);
  await handler.handleOverlayEnded('read-studio', 'studio-a', 'ended', 'legacy:legacy-a'); assert.equal(data.get('twitch:read-studio:tts:processing'), 'studio-a');
  await handler.handleOverlayEnded('read-studio', 'studio-a', 'ended', 'studio:original-owner');
  for (const socket of legacySockets.values()) socket.data.ttsReady = true;
  readRoute = null; seed('read-default', 'default-a'); await handler.processNext('read-default');
  assert.equal((handler as any).currentTimeouts.get('read-default:default-a')._idleTimeout, 60000);
  await handler.handleSpeechEnded('read-default', 'default-a');
});
for (const action of ['skip', 'clear', 'refresh'] as const) test(`readTTS ${action} stops/releases active pet exactly once`, async () => {
  readRoute = 'pet'; const channel = `read-${action}`, id = `pet-${action}`; seed(channel, id); await handler.processNext(channel);
  await handler.control(channel, action); assert.equal(released.filter(speech => speech === id).length, 1);
  await lastInput.ended('pet:cancelled'); assert.equal(released.filter(speech => speech === id).length, 1);
});
