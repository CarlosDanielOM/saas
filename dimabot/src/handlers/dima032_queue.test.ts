import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const data = new Map<string, string>();
const queues = new Map<string, string[]>();
const events: { channel: string; event: string; payload: any }[] = [];
let refreshes = 0;
let synthesize: (input: any) => Promise<any> = async () => ({ error: false, outputPath: '/tmp/tts-controls.wav', publicPath: '/audio/test' });
const synthesized: string[] = [];
let usage = 0;
let studioConnected = true, graceConnected = true, petReady = true, playbackTimeoutMs = 60000;
const turns = new Map<string, string>(), protections: number[] = [];
let afterRequeueWrite: (() => Promise<void>) | undefined, onReserve: (() => void) | undefined;
let publisher: ((input: any) => Promise<'emitted' | 'unavailable' | 'cancelled'>) | undefined;
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
  zAdd: async (key: string, entry: any) => { const ids = queues.get(key) ?? []; if (!ids.includes(entry.value)) ids.push(entry.value); queues.set(key, ids); if (afterRequeueWrite) { const barrier = afterRequeueWrite; afterRequeueWrite = undefined; await barrier(); } },
  zRem: async (key: string, id: string) => { queues.set(key, (queues.get(key) ?? []).filter(item => item !== id)); },
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
mock.module('../utils/tts/tts_playback_timeout.util.js', { namedExports: { getTtsPlaybackTimeoutMs: async () => playbackTimeoutMs } });
for (const provider of ['piper', 'fish', 'kokoro']) mock.module(`../server/services/tts/${provider}_tts.service.js`, { namedExports: {
  [`${provider}TtsService`]: { synthesize: (input: any) => { synthesized.push(input.speechID); return synthesize(input); } },
  ...(provider === 'piper' ? { PIPER_PUBLIC_SPEECH_DIR: '/tmp/tts-controls' } : {})
} });
const { ttsQueueHandler: handler } = await import('./tts_queue.handler.js');
const { registerStudioBridge } = await import('../overlays/bridge.js');
const studio: string[] = [];
registerStudioBridge({ hasSource: () => graceConnected, hasLiveSource: () => studioConnected, media: async () => {}, trigger: async () => {}, controlTts: async (_channel, action) => { studio.push(action); }, readTts: async (_channel, input) => { readDeliveries.push(input); if (publisher) return publisher(input); return input.beforeEmit?.() === false ? 'cancelled' : 'emitted'; } });
const { registerReadTtsBridge } = await import('../pets/tts_bridge.js');
registerReadTtsBridge({ configured: async () => readRoute !== null, owns: (channel, speech) => turns.has(channel) && (!speech || turns.get(channel) === speech), current: (channel, speech) => turns.get(channel) === speech, protect: async (_channel, _speech, hold) => { protections.push(hold); return true; }, reserve: async input => { if (readRoute) turns.set(input.channelId, input.speechId); onReserve?.(); return true; }, available: async () => readRoute === 'pet' && petReady, prepare: async input => { if (readRoute) turns.set(input.channelId,input.speechId); lastInput = input; return readRoute ? { audio: readRoute, durationMs: 500 } : null; }, release: async (channel, speech) => { released.push(speech); if (turns.get(channel) === speech) turns.delete(channel); }, report: async () => {}, terminal: async () => {}, invalidated: async () => {} });

function seed(channel: string, ...ids: string[]) {
  queues.set(`twitch:${channel}:tts:queue`, ids);
  for (const speechID of ids) data.set(`twitch:${channel}:tts:queue:data:${speechID}`, JSON.stringify({ channelID: channel, speechID, provider: 'piper', mode: 'speak', language: 'en', voice: 'test', text: speechID }));
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('condition timed out');
}
const dispatched = (id: string) => events.some(e => e.event === 'speech' && e.payload.speechID === id);


const channels = ['read-pet', 'read-overlay', 'read-studio', 'read-default', 'read-skip', 'read-clear', 'read-refresh', 'studio-backlog', 'synth-output-loss', 'retained-output-loss', 'long-paused', 'requeue-control'];
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

function legacyReady(ready: boolean) { for (const socket of legacySockets.values()) socket.data.ttsReady = ready; }
test('Studio disconnected grace cannot synthesize waiting readTTS backlog; live reconnect resumes without new enqueue', async () => {
  readRoute = 'overlay'; legacyReady(false); studioConnected = false; graceConnected = true; petReady = false;
  const before = usage; seed('studio-backlog', 'backlog-a'); await handler.processNext('studio-backlog');
  assert.equal(usage, before); assert.deepEqual(queues.get('twitch:studio-backlog:tts:queue'), ['backlog-a']);
  studioConnected = true; await handler.resumeIfIdle('studio-backlog'); await until(() => readDeliveries.some(item => item.speechID === 'backlog-a'));
  assert.equal(usage, before + 1); await handler.handleOverlayEnded('studio-backlog', 'backlog-a', 'ended', 'studio:live'); legacyReady(true);
});
test('output loss during synthesis retains same file, debit and queue until a live Studio can receive it once', async () => {
  readRoute = 'overlay'; legacyReady(false); studioConnected = true;
  let unblock!: (value: any) => void, entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  const original = synthesize; synthesize = async () => { entered(); return new Promise(resolve => { unblock = resolve; }); };
  const before = usage; seed('synth-output-loss', 'loss-a'); const processing = handler.processNext('synth-output-loss'); await reached;
  studioConnected = false; await handler.handleOverlayDisconnected('synth-output-loss'); unblock(await original({}));
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(usage, before + 1);
  assert.equal(readDeliveries.some(item => item.speechID === 'loss-a'), false);
  studioConnected = true; await handler.resumeIfIdle('synth-output-loss'); await processing; await until(() => readDeliveries.some(item => item.speechID === 'loss-a'));
  assert.equal(readDeliveries.filter(item => item.speechID === 'loss-a').length, 1); assert.equal(usage, before + 1);
  await handler.handleOverlayEnded('synth-output-loss', 'loss-a', 'ended', 'studio:live'); synthesize = original; legacyReady(true);
});
test('proved-unsent retained delivery retries same file after disconnect; no second synthesis or usage', async () => {
  readRoute = 'overlay'; legacyReady(false); studioConnected = true;
  let unblock!: () => void, entered!: () => void, first = true; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { unblock = resolve; });
  publisher = async input => { if (first) { first = false; entered(); await blocked; return 'unavailable'; } return input.beforeEmit() ? 'emitted' : 'cancelled'; };
  const before = usage; seed('retained-output-loss', 'retain-a'); const processing = handler.processNext('retained-output-loss'); await reached;
  studioConnected = false; await handler.handleOverlayDisconnected('retained-output-loss'); unblock();
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(usage, before + 1);
  studioConnected = true; await handler.resumeIfIdle('retained-output-loss'); await processing; await until(() => readDeliveries.filter(item => item.speechID === 'retain-a').length === 2); const attempts = readDeliveries.filter(item => item.speechID === 'retain-a');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].file, attempts[1].file); assert.equal(usage, before + 1);
  await handler.handleOverlayEnded('retained-output-loss', 'retain-a', 'ended', 'studio:live'); publisher = undefined; legacyReady(true);
});
test('paused 300-second normal media uses 330-second watchdog and at least 510-second reservation proof', async () => {
  readRoute = 'overlay'; legacyReady(false); studioConnected = true; playbackTimeoutMs = 330000;
  seed('long-paused', 'long-a'); await handler.processNext('long-paused');
  assert.equal(lastInput.holdMs, 510000); assert.ok(protections.at(-1)! >= 510000);
  assert.equal((handler as any).currentTimeouts.get('long-paused:long-a')._idleTimeout, 330000);
  await handler.handleOverlayEnded('long-paused', 'long-a', 'ended', 'studio:live'); playbackTimeoutMs = 60000; legacyReady(true);
});

test('skip crossing requeue Redis write cannot resurrect the unheard current item or synthesize it', async () => {
  readRoute = 'overlay'; legacyReady(false); studioConnected = true; const before = usage;
  let unblock!: () => void, entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { unblock = resolve; });
  onReserve = () => { studioConnected = false; onReserve = undefined; };
  afterRequeueWrite = async () => { entered(); await blocked; };
  seed('requeue-control', 'requeued-a'); const processing = handler.processNext('requeue-control'); await reached;
  const skip = handler.control('requeue-control', 'skip'); await new Promise(resolve => setTimeout(resolve, 5)); unblock();
  await Promise.all([processing, skip]); assert.equal(usage, before); assert.deepEqual(queues.get('twitch:requeue-control:tts:queue'), []);
  studioConnected = true; legacyReady(true);
});

test('initial generated dispatch and resumed dispatch share the eight-pump limit', async () => {
  readRoute='overlay'; studioConnected=true; legacyReady(false);
  let unblock!:()=>void; const blocked=new Promise<void>(resolve=>{unblock=resolve;}); let entered=0,peak=0;
  publisher=async input=>{entered++; peak=Math.max(peak,(handler as any).activePumps); await blocked; return input.beforeEmit()?'emitted':'cancelled';};
  const ids=Array.from({length:12},(_,i)=>`pump-${i}`); ids.forEach(id=>{channels.push(id); seed(id,id);});
  const processing=ids.map(id=>handler.processNext(id));
  try {
    await until(()=>entered===8); assert.equal((handler as any).activePumps,8); assert.ok((handler as any).headWakes.size<=4);
    unblock(); await Promise.all(processing); await until(()=>ids.every(id=>(handler as any).readHeads.get(id)?.phase==='emitted'));
    assert.ok(peak<=8); assert.equal(entered,12);
  } finally {unblock(); publisher=undefined; for(const id of ids) await handler.control(id,'clear'); legacyReady(true);}
});
test('descriptor capacity applies before provider work; invalid payload loops release their claim', async () => {
  readRoute='overlay'; studioConnected=true; legacyReady(false);
  const internals=handler as any, originalHeads=internals.readHeads;
  internals.readHeads=new Map(Array.from({length:128},(_,i)=>[`occupied-${i}`,{}]));
  const before=usage; seed('at-capacity','capacity-a'); channels.push('at-capacity');
  try {await handler.processNext('at-capacity'); assert.equal(usage,before); assert.deepEqual(queues.get('twitch:at-capacity:tts:queue'),['capacity-a']); assert.equal(internals.headClaims.size,0);}
  finally {internals.readHeads=originalHeads; internals.capacityWaiters.clear(); queues.set('twitch:at-capacity:tts:queue',[]);}
  seed('invalid-payloads','valid'); channels.push('invalid-payloads'); queues.set('twitch:invalid-payloads:tts:queue',['missing','malformed','valid']); data.set('twitch:invalid-payloads:tts:queue:data:malformed','{');
  await handler.processNext('invalid-payloads'); assert.equal(internals.headClaims.size,0); assert.equal(usage,before+1);
  await handler.control('invalid-payloads','clear'); legacyReady(true);
});
test('uncertain emitted dispatch finishes its own cleanup before next head can own the producer lock', async () => {
  readRoute='overlay'; studioConnected=true; legacyReady(false); channels.push('terminal-handoff'); seed('terminal-handoff','uncertain-a','uncertain-b'); let first=true;
  publisher=async input=>{if(first){first=false; input.beforeEmit(); throw new Error('uncertain after owner emission');} return input.beforeEmit()?'emitted':'cancelled';};
  try {
    await handler.processNext('terminal-handoff'); await until(()=>(handler as any).readHeads.get('terminal-handoff')?.phase==='emitted');
    assert.equal((handler as any).readHeads.get('terminal-handoff').item.speechID,'uncertain-b');
    assert.equal((handler as any).processingChannels.has('terminal-handoff'),true);
    assert.equal(data.get('twitch:terminal-handoff:tts:processing'),'uncertain-b');
    assert.equal(synthesized.filter(id=>id==='uncertain-a').length,1); assert.equal(synthesized.filter(id=>id==='uncertain-b').length,1);
  } finally {publisher=undefined; await handler.control('terminal-handoff','clear'); legacyReady(true);}
});
