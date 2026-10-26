import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Minimal in-memory Redis: one sorted queue per channel plus string keys.
const queues = new Map<string, Map<string, number>>();
const strings = new Map<string, string>();
const sorted = (key: string) => [...(queues.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
const cache = {
  eval: async (script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> => {
    if (script.includes('DIMA032_POP')) {
      const [queue, session, data] = options.keys;
      const [first] = sorted(queue);
      if (!first) return [];
      if (first !== options.arguments[0]) return ['retry'];
      queues.get(queue)!.delete(first);
      return [first, strings.get(data) ?? '', strings.get(session) ?? ''];
    }
    throw new Error('unexpected script');
  },
  zRange: async (key: string, start: number, stop: number) => sorted(key).slice(start, stop === -1 ? undefined : stop + 1),
  zCard: async (key: string) => queues.get(key)?.size ?? 0,
  zRem: async (key: string, ids: string | string[]) => { for (const id of [ids].flat()) queues.get(key)?.delete(id); },
  get: async (key: string) => strings.get(key) ?? null,
  set: async (key: string, value: string) => { strings.set(key, value); },
  del: async (key: string) => { strings.delete(key); },
  keys: async () => [] as string[],
  multi: () => { const ops: Array<() => void> = []; const tx = { zRem: (k: string, ids: string[]) => { ops.push(() => { for (const id of ids) queues.get(k)?.delete(id); }); return tx; },
    del: (k: string) => { ops.push(() => strings.delete(k)); return tx; }, exec: async () => { for (const op of ops) op(); } }; return tx; },
};
function enqueue(channel: string, id: string, score: number, payload: Record<string, unknown>) {
  const key = `twitch:${channel}:tts:queue`;
  if (!queues.has(key)) queues.set(key, new Map());
  queues.get(key)!.set(id, score);
  strings.set(`twitch:${channel}:tts:queue:data:${id}`, JSON.stringify({ ...payload, speechID: id, queueSession: null }));
}
const normal = (channel: string, id: string, score: number) => enqueue(channel, id, score,
  { channelID: channel, source: 'chat-command', mode: 'speak', provider: 'piper', text: `normal ${id}`, language: 'en', voice: 'piper-en', timestamp: score });
const petItem = (channel: string, id: string, score: number, requestId: string) => enqueue(channel, id, score,
  { channelID: channel, source: 'ast', mode: 'speak', provider: 'piper', text: 'pet', language: 'en', voice: '', timestamp: score,
    pet: { requestId, ownerId: '111111111111111111111111', operation: 'talk' } });

let overlayConnected = true;
const timeline: string[] = [];
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../server/websocket.js', { namedExports: { getIO: () => ({ of: () => ({
  sockets: new Map(overlayConnected ? [['overlay', { connected: true, data: { ttsReady: true } }]] : []),
  emit: (event: string, payload: { speechID: string }) => { if (event === 'speech') timeline.push(`tts:${payload.speechID}`); },
}) }) } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ plan_tier: 'free' }) } });
mock.module('../utils/billing.js', { namedExports: { isAiCreditsExhausted: async () => false, getAiCredits: async () => ({ status: 'available' }) } });
mock.module('../utils/tts_usage.js', { namedExports: { trackTtsUsage: async () => {} } });
mock.module('../utils/posthog_events.js', { namedExports: { trackAiOperation: () => {} } });
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => 30_000 } });
for (const provider of ['fish', 'piper', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: async (request: { speechID: string }) => ({ error: false, message: 'ok', outputPath: `/tmp/pet-lane-${request.speechID}.wav`, publicPath: `/audio/${request.speechID}`, mimeType: 'audio/wav' }) },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/pet-lane-test' } : {}),
} });

const { ttsQueueHandler } = await import('./tts_queue.handler.js');
const { registerPetLaneBridge } = await import('../pets/tts_lane.js');

// Fake pet runtime: each started turn finishes when the test says so.
const finishers = new Map<string, (reason: string) => void>();
const ended: Array<{ requestId: string; reason: string }> = [];
let startResult: 'start' | 'refuse' | 'wait' = 'start';
registerPetLaneBridge({
  start: async input => {
    timeline.push(`pet:${input.speechId}`);
    if (startResult === 'refuse') return null;
    // Pet busy with an independent request: wait like the runtime does until a control cancels.
    if (startResult === 'wait') { while (!input.cancelled()) await new Promise(resolve => setTimeout(resolve, 5)); return null; }
    return { done: new Promise<string>(resolve => finishers.set(input.speechId, resolve)) };
  },
  end: async (item, reason) => { ended.push({ requestId: item.requestId, reason }); },
  terminal: () => {},
});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
async function finishNormal(channel: string, id: string) { await ttsQueueHandler.handleSpeechEnded(channel, id, 'ended'); await settle(); }
async function finishPet(id: string) { finishers.get(id)!('pet:completed'); await settle(); }
function reset() { queues.clear(); strings.clear(); timeline.length = 0; ended.length = 0; finishers.clear(); overlayConnected = true; startResult = 'start'; }

test('TTS, TTS, pet.talk, TTS play strictly in arrival order and the pet holds the queue', async () => {
  reset();
  const channel = 'order';
  normal(channel, 'A', 1); normal(channel, 'B', 2); petItem(channel, 'PET0000000000001', 3, '00000000-0000-4000-8000-000000000001'); normal(channel, 'C', 4);
  await ttsQueueHandler.processNext(channel); await settle();
  assert.deepEqual(timeline, ['tts:A']);
  await finishNormal(channel, 'A');
  assert.deepEqual(timeline, ['tts:A', 'tts:B']);
  await finishNormal(channel, 'B');
  assert.deepEqual(timeline, ['tts:A', 'tts:B', 'pet:PET0000000000001']);
  // While the pet talks, the next normal message waits and late overlay events cannot end the pet turn.
  await ttsQueueHandler.handleSpeechEnded(channel, 'B', 'ended'); await ttsQueueHandler.handleOverlayDisconnected(channel); await settle();
  assert.deepEqual(timeline, ['tts:A', 'tts:B', 'pet:PET0000000000001']);
  assert.equal((await ttsQueueHandler.getStatus(channel)).queueLength, 1);
  await finishPet('PET0000000000001');
  assert.deepEqual(timeline, ['tts:A', 'tts:B', 'pet:PET0000000000001', 'tts:C']);
  assert.deepEqual(ended, [{ requestId: '00000000-0000-4000-8000-000000000001', reason: 'pet:completed' }], 'a finished pet turn is only reported, not cancelled');
  await finishNormal(channel, 'C');
});

test('skip during a pet turn stops the pet and moves to the next message', async () => {
  reset();
  const channel = 'skip';
  petItem(channel, 'PET0000000000002', 1, '00000000-0000-4000-8000-000000000002'); normal(channel, 'D', 2);
  await ttsQueueHandler.processNext(channel); await settle();
  assert.deepEqual(timeline, ['pet:PET0000000000002']);
  await ttsQueueHandler.control(channel, 'skip'); await settle();
  assert.deepEqual(ended, [{ requestId: '00000000-0000-4000-8000-000000000002', reason: 'skip' }]);
  assert.deepEqual(timeline, ['pet:PET0000000000002', 'tts:D']);
  // The pet runtime reports its cancellation afterwards; it must not end message D.
  finishers.get('PET0000000000002')!('pet:cancelled'); await settle();
  assert.equal(timeline.length, 2);
  await finishNormal(channel, 'D');
});

test('a pet item that cannot start is skipped without blocking later TTS', async () => {
  reset(); startResult = 'refuse';
  const channel = 'refuse';
  petItem(channel, 'PET0000000000003', 1, '00000000-0000-4000-8000-000000000003'); normal(channel, 'E', 2);
  await ttsQueueHandler.processNext(channel); await settle();
  assert.deepEqual(timeline, ['pet:PET0000000000003', 'tts:E']);
  await finishNormal(channel, 'E');
});

test('a pet item plays without a speech overlay, and later normal TTS still waits for one', async () => {
  reset(); overlayConnected = false;
  const channel = 'pet-only';
  petItem(channel, 'PET0000000000004', 1, '00000000-0000-4000-8000-000000000004'); normal(channel, 'F', 2);
  await ttsQueueHandler.processNext(channel); await settle();
  assert.deepEqual(timeline, ['pet:PET0000000000004']);
  await finishPet('PET0000000000004');
  assert.deepEqual(timeline, ['pet:PET0000000000004'], 'no overlay: F is kept, not dropped');
  assert.deepEqual(await cache.zRange(`twitch:${channel}:tts:queue`, 0, -1), ['F']);
  overlayConnected = true;
  await ttsQueueHandler.resumeIfIdle(channel); await settle();
  assert.deepEqual(timeline, ['pet:PET0000000000004', 'tts:F']);
  await finishNormal(channel, 'F');
});

test('clear removes waiting pet items', async () => {
  reset();
  const channel = 'clear';
  normal(channel, 'G', 1); petItem(channel, 'PET0000000000005', 2, '00000000-0000-4000-8000-000000000005');
  await ttsQueueHandler.processNext(channel); await settle();
  await ttsQueueHandler.control(channel, 'clear'); await settle();
  assert.deepEqual(timeline, ['tts:G']);
  assert.equal(await cache.zCard(`twitch:${channel}:tts:queue`), 0);
});

test('skip while the pet item waits for a busy pet cancels only that item', async () => {
  reset(); startResult = 'wait';
  const channel = 'wait-skip';
  petItem(channel, 'PET0000000000006', 1, '00000000-0000-4000-8000-000000000006'); normal(channel, 'H', 2);
  void ttsQueueHandler.processNext(channel); await settle();
  assert.deepEqual(timeline, ['pet:PET0000000000006'], 'H waits behind the pet item');
  await ttsQueueHandler.control(channel, 'skip');
  for (let i = 0; i < 50 && timeline.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(timeline, ['pet:PET0000000000006', 'tts:H']);
  assert.equal(ended.length, 1, 'the unstarted pet item is ended once');
  await finishNormal(channel, 'H');
});
